use std::ptr::NonNull;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSEventModifierFlags};

// A focused child webview (the browser pane) consumes ⌘-key equivalents via
// WebKit's performKeyEquivalent: before AppKit's main menu ever runs, so the
// app's menu accelerators (⌘W/⌘P/⌘T/⌘B/⌘1-9/…) go dead app-wide the moment such
// a pane takes focus.
// A local key-down monitor runs before the event reaches the responder chain,
// so giving the main menu the first crack here restores those shortcuts
// regardless of which webview holds focus. The menu already owns every mapping,
// so nothing is hard-coded; keys the menu doesn't claim pass straight through.
pub fn install() {
    if MainThreadMarker::new().is_none() {
        log::warn!("shortcut monitor: setup must run on the main thread");
        return;
    }
    let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands us a live NSEvent for the duration of this call.
        let ev = unsafe { event.as_ref() };
        if !ev.modifierFlags().contains(NSEventModifierFlags::Command) {
            return event.as_ptr();
        }
        let ch = ev
            .charactersIgnoringModifiers()
            .map(|c| c.to_string())
            .unwrap_or_default();
        // Clipboard and undo belong to whatever holds focus (terminal, editor,
        // the web page itself) — never route those through the menu.
        if matches!(
            ch.to_ascii_lowercase().as_str(),
            "c" | "v" | "x" | "a" | "z"
        ) {
            return event.as_ptr();
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return event.as_ptr();
        };
        let handled = NSApplication::sharedApplication(mtm)
            .mainMenu()
            .map(|menu| menu.performKeyEquivalent(ev))
            .unwrap_or(false);
        if handled {
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    // SAFETY: the block returns a valid NSEvent pointer or null, per the
    // method's documented contract.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    // The monitor lives for the whole process; leak both it and its block so
    // AppKit keeps calling into a valid closure for the app's lifetime.
    std::mem::forget(monitor);
    std::mem::forget(block);
}
