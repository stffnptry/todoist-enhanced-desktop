// Mails aus Outlook ins Fenster ziehen.
//
// Outlook gibt beim Ziehen keine Datei und keinen Text mit, sondern nur ein
// „Datei-Versprechen“ (file promise): Die .eml-Datei entsteht erst, wenn das
// Ziel einen Ordner nennt. Chromium kennt diese Art nicht, meldet sich dafür
// gar nicht erst als Ablageziel – die Seite bekommt vom Ziehen nichts mit.
//
// Dieses kleine Node-Modul hängt sich deshalb an die Ansicht der Seite:
// - es meldet sie zusätzlich für Datei-Versprechen an, damit Chromium das
//   Ziehen an die Seite weitergibt (die Seite sieht dann ein leeres Ziehen);
// - beim Ablegen lässt es sich die versprochenen Dateien in einen eigenen
//   Ordner schreiben und meldet main.js jede fertige Datei (siehe
//   promisedMails() dort). Danach läuft Chromiums eigenes Ablegen weiter.
//
// Gebaut wird es von build-de.sh (clang++, Node-API-Header aus node_modules).

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include <string>

#define NAPI_VERSION 8
#include <node_api.h>

namespace {

struct Event {
  std::string kind;
  std::string value;
};

napi_threadsafe_function gNotify = nullptr;
NSString* gDirectory = nil;
NSOperationQueue* gQueue = nil;
NSMutableSet* gPatched = nil;

void Notify(NSString* kind, NSString* value) {
  if (!gNotify) return;
  Event* event = new Event{kind.UTF8String ?: "", value.UTF8String ?: ""};
  if (napi_call_threadsafe_function(gNotify, event, napi_tsfn_nonblocking) != napi_ok) delete event;
}

void CallJs(napi_env env, napi_value callback, void* /*context*/, void* data) {
  Event* event = static_cast<Event*>(data);
  if (env && callback) {
    napi_value object, kind, value, receiver;
    napi_create_object(env, &object);
    napi_create_string_utf8(env, event->kind.c_str(), NAPI_AUTO_LENGTH, &kind);
    napi_create_string_utf8(env, event->value.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, object, "kind", kind);
    napi_set_named_property(env, object, "value", value);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &object, nullptr);
  }
  delete event;
}

// Apple Mail und der Finder geben Links bzw. echte Dateien mit, die Chromium
// selbst liest; nur bei reinen Versprechen (Outlook u. a.) springt das Modul ein.
bool ChromiumReadsItself(NSPasteboard* board) {
  NSDictionary* fileOnly = @{NSPasteboardURLReadingFileURLsOnlyKey: @YES};
  if ([board canReadObjectForClasses:@[[NSURL class]] options:fileOnly]) return true;
  for (NSPasteboardItem* item in board.pasteboardItems) {
    NSString* url = [item stringForType:NSPasteboardTypeURL];
    if ([url hasPrefix:@"message:"]) return true;
  }
  return false;
}

void ReceivePromises(id<NSDraggingInfo> info) {
  NSPasteboard* board = [info draggingPasteboard];
  if (!board || !gDirectory || ChromiumReadsItself(board)) return;
  NSArray* receivers = [board readObjectsForClasses:@[[NSFilePromiseReceiver class]] options:nil];
  if (receivers.count == 0) return;

  // Ein frischer Ordner je Ablegen: Gleichnamige Mails überschreiben sich nicht.
  NSString* folder = [gDirectory stringByAppendingPathComponent:[NSUUID UUID].UUIDString];
  NSError* error = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:&error]) {
    Notify(@"error", error.localizedDescription ?: @"folder");
    return;
  }
  NSUInteger expected = 0;
  for (NSFilePromiseReceiver* receiver in receivers) expected += MAX((NSUInteger)1, receiver.fileNames.count);
  Notify(@"start", [NSString stringWithFormat:@"%lu", (unsigned long)expected]);

  NSURL* destination = [NSURL fileURLWithPath:folder isDirectory:YES];
  for (NSFilePromiseReceiver* receiver in receivers) {
    [receiver receivePromisedFilesAtDestination:destination
                                        options:@{}
                                 operationQueue:gQueue
                                         reader:^(NSURL* file, NSError* failure) {
                                           if (failure) Notify(@"error", failure.localizedDescription ?: @"promise");
                                           else Notify(@"file", file.path ?: @"");
                                         }];
  }
}

// performDragOperation: der Klasse ersetzen, die Chromium als Ablageziel
// angemeldet hat: erst die Versprechen einlösen, dann Chromiums Original.
void PatchClass(Class cls) {
  if ([gPatched containsObject:cls]) return;
  SEL selector = @selector(performDragOperation:);
  Method method = class_getInstanceMethod(cls, selector);
  if (!method) return;
  typedef BOOL (*Perform)(id, SEL, id<NSDraggingInfo>);
  Perform original = reinterpret_cast<Perform>(method_getImplementation(method));
  IMP replacement = imp_implementationWithBlock(^BOOL(id view, id<NSDraggingInfo> info) {
    @try {
      ReceivePromises(info);
    } @catch (NSException* exception) {
      Notify(@"error", exception.reason ?: @"exception");
    }
    return original(view, selector, info);
  });
  // Erbt die Klasse die Methode nur, bekommt sie eine eigene; sonst wird ersetzt.
  if (!class_addMethod(cls, selector, replacement, method_getTypeEncoding(method))) {
    method_setImplementation(method, replacement);
  }
  [gPatched addObject:cls];
}

// Alle Ansichten im Fenster, die Dateien annehmen (Chromiums WebContentsViewCocoa).
int Register(NSView* view) {
  int found = 0;
  NSArray* types = view.registeredDraggedTypes;
  if ([types containsObject:NSPasteboardTypeFileURL]) {
    NSMutableArray* wanted = [types mutableCopy];
    NSArray* extra = [[NSFilePromiseReceiver readableDraggedTypes] arrayByAddingObjectsFromArray:@[
      @"com.apple.pasteboard.promised-file-url",
      @"com.apple.pasteboard.promised-file-content-type",
      @"com.apple.NSFilePromiseItemMetaData",
      @"Apple files promise pasteboard type",
    ]];
    for (NSString* type in extra) {
      if (![wanted containsObject:type]) [wanted addObject:type];
    }
    [view registerForDraggedTypes:wanted];
    PatchClass([view class]);
    found += 1;
  }
  for (NSView* child in view.subviews) found += Register(child);
  return found;
}

napi_value Fail(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

// install(nativeWindowHandle: Buffer, folder: string, onEvent: (event) => void) → Anzahl Ansichten
napi_value Install(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 3) {
    return Fail(env, "install(handle, folder, callback)");
  }

  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void*)) {
    return Fail(env, "handle must be the window's native handle");
  }
  NSView* root = (__bridge NSView*)(*static_cast<void**>(data));

  char folder[4096];
  size_t folderLength = 0;
  if (napi_get_value_string_utf8(env, argv[1], folder, sizeof(folder), &folderLength) != napi_ok || folderLength == 0) {
    return Fail(env, "folder must be a path");
  }

  if (!gNotify) {
    napi_value name;
    napi_create_string_utf8(env, "dragpromise", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &gNotify) != napi_ok) {
      return Fail(env, "could not create callback");
    }
    // Hält Electron nicht am Leben, wenn alles andere beendet ist.
    napi_unref_threadsafe_function(env, gNotify);
    gQueue = [[NSOperationQueue alloc] init];
    gPatched = [NSMutableSet set];
  }
  gDirectory = [NSString stringWithUTF8String:folder];

  int found = 0;
  if ([root isKindOfClass:[NSView class]]) {
    NSView* top = root.window.contentView ?: root;
    found = Register(top.superview ?: top);
  }
  napi_value result;
  napi_create_int32(env, found, &result);
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value install;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, Install, nullptr, &install);
  napi_set_named_property(env, exports, "install", install);
  return exports;
}
