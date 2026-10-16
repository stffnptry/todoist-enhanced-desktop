// calhelper: liest und schreibt Termine im macOS-Kalender (EventKit) für die
// Mac-App. Aufruf: calhelper <befehl> [json]; Antwort immer ein JSON-Objekt
// auf stdout: {"ok":true,...} oder {"ok":false,"error":"..."}.
//
//   status                      Zugriff melden, ohne zu fragen
//   access                      Zugriff anfragen bzw. Status melden
//   calendars                   alle Terminkalender
//   events {from,to,calendars}  Termine im Zeitraum (ISO-Zeiten, Kalender-IDs)
//   create {calendar,title,start,end,notes,url}
//   update {id,start,end,title}
//   delete {id}
//   create-calendar {title}     neuer Kalender beim Google-Konto (CalDAV)

import EventKit
import Foundation

let store = EKEventStore()
let iso: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()
let isoPlain = ISO8601DateFormatter()

func parseDate(_ value: Any?) -> Date? {
  guard let s = value as? String else { return nil }
  return iso.date(from: s) ?? isoPlain.date(from: s)
}

func reply(_ object: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{\"ok\":false}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func fail(_ message: String) -> Never { reply(["ok": false, "error": message]) }

func hex(_ color: CGColor?) -> String {
  guard let c = color, let rgb = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
        let comps = rgb.components, comps.count >= 3 else { return "#888888" }
  return String(format: "#%02x%02x%02x", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
}

func authorized() -> Bool {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) { return status == .fullAccess }
  return status == .authorized
}

func requestAccess() -> Bool {
  if authorized() { return true }
  let done = DispatchSemaphore(value: 0)
  var granted = false
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in granted = ok; done.signal() }
  } else {
    store.requestAccess(to: .event) { ok, _ in granted = ok; done.signal() }
  }
  done.wait()
  return granted
}

func statusName() -> String {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    switch status {
    case .fullAccess: return "granted"
    case .writeOnly: return "writeOnly"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "notDetermined"
    default: return "unknown"
    }
  }
  switch status {
  case .authorized: return "granted"
  case .denied, .restricted: return "denied"
  case .notDetermined: return "notDetermined"
  default: return "unknown"
  }
}

func calendarJSON(_ cal: EKCalendar) -> [String: Any] {
  [
    "id": cal.calendarIdentifier,
    "title": cal.title,
    "color": hex(cal.cgColor),
    "source": cal.source?.title ?? "",
    "sourceType": cal.source.map { String($0.sourceType.rawValue) } ?? "",
    "writable": cal.allowsContentModifications,
    "subscribed": cal.type == .subscription,
  ]
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("no command") }
let command = args[1]
var input: [String: Any] = [:]
if args.count >= 3, let data = args[2].data(using: .utf8),
   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
  input = parsed
}

if command == "status" {
  // Nur nachsehen, nie fragen.
  reply(["ok": true, "granted": authorized(), "status": statusName()])
}

if command == "access" {
  let ok = requestAccess()
  reply(["ok": true, "granted": ok, "status": statusName()])
}

guard requestAccess() else { reply(["ok": false, "error": "denied", "status": statusName()]) }

switch command {
case "calendars":
  reply(["ok": true, "calendars": store.calendars(for: .event).map(calendarJSON)])

case "events":
  guard let from = parseDate(input["from"]), let to = parseDate(input["to"]) else { fail("from/to missing") }
  let ids = Set((input["calendars"] as? [String]) ?? [])
  let calendars = store.calendars(for: .event).filter { ids.isEmpty || ids.contains($0.calendarIdentifier) }
  if calendars.isEmpty { reply(["ok": true, "events": []]) }
  let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
  let events = store.events(matching: predicate).map { e -> [String: Any] in
    [
      "id": e.eventIdentifier ?? "",
      "calendarId": e.calendar.calendarIdentifier,
      "title": e.title ?? "",
      "start": iso.string(from: e.startDate),
      "end": iso.string(from: e.endDate),
      "allDay": e.isAllDay,
      "location": e.location ?? "",
      "notes": e.notes ?? "",
      "url": e.url?.absoluteString ?? "",
    ]
  }
  reply(["ok": true, "events": events])

case "create":
  guard let calId = input["calendar"] as? String, let cal = store.calendar(withIdentifier: calId) else { fail("calendar not found") }
  guard let start = parseDate(input["start"]), let end = parseDate(input["end"]) else { fail("start/end missing") }
  let event = EKEvent(eventStore: store)
  event.calendar = cal
  event.title = (input["title"] as? String) ?? ""
  event.startDate = start
  event.endDate = end
  if let notes = input["notes"] as? String, !notes.isEmpty { event.notes = notes }
  if let url = input["url"] as? String, let u = URL(string: url) { event.url = u }
  do { try store.save(event, span: .thisEvent, commit: true) } catch { fail(error.localizedDescription) }
  reply(["ok": true, "id": event.eventIdentifier ?? ""])

case "update":
  guard let id = input["id"] as? String, let event = store.event(withIdentifier: id) else { fail("event not found") }
  if let start = parseDate(input["start"]) { event.startDate = start }
  if let end = parseDate(input["end"]) { event.endDate = end }
  if let title = input["title"] as? String { event.title = title }
  do { try store.save(event, span: .thisEvent, commit: true) } catch { fail(error.localizedDescription) }
  reply(["ok": true])

case "delete":
  guard let id = input["id"] as? String, let event = store.event(withIdentifier: id) else { fail("event not found") }
  do { try store.remove(event, span: .thisEvent, commit: true) } catch { fail(error.localizedDescription) }
  reply(["ok": true])

case "create-calendar":
  let title = (input["title"] as? String) ?? "Aufgaben"
  // Beim Google-Konto anlegen (CalDAV), sonst iCloud, sonst lokal.
  let sources = store.sources
  let google = sources.first { $0.sourceType == .calDAV && ($0.title.lowercased().contains("gmail") || $0.title.lowercased().contains("google")) }
  let preferred = (input["source"] as? String).flatMap { name in sources.first { $0.title == name } }
  guard let source = preferred ?? google ?? sources.first(where: { $0.sourceType == .calDAV }) ?? sources.first(where: { $0.sourceType == .local }) else { fail("no source") }
  let cal = EKCalendar(for: .event, eventStore: store)
  cal.title = title
  cal.source = source
  do { try store.saveCalendar(cal, commit: true) } catch { fail(error.localizedDescription) }
  reply(["ok": true, "calendar": calendarJSON(cal)])

default:
  fail("unknown command")
}
