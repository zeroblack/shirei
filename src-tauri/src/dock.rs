use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ClassBuilder, Sel};
use objc2::{MainThreadMarker, sel};
use objc2_app_kit::{NSApplication, NSMenu};
use objc2_foundation::NSString;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn install(app: &tauri::AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("dock menu: setup must run on the main thread");
        return;
    };
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
        log::warn!("dock menu: no application delegate to extend");
        return;
    };
    let delegate_obj: &AnyObject = unsafe { &*(Retained::as_ptr(&delegate).cast::<AnyObject>()) };

    let Some(mut builder) = ClassBuilder::new(c"ShireiDockDelegate", delegate_obj.class()) else {
        log::warn!("dock menu: could not subclass the application delegate");
        return;
    };
    unsafe {
        builder.add_method(
            sel!(applicationDockMenu:),
            dock_menu as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu,
        );
        builder.add_method(
            sel!(shireiNewWindow:),
            new_window as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject),
        );
    }
    let subclass = builder.register();
    unsafe { AnyObject::set_class(delegate_obj, subclass) };
}

extern "C" fn dock_menu(this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> *mut NSMenu {
    let Some(mtm) = MainThreadMarker::new() else {
        return std::ptr::null_mut();
    };
    let menu = NSMenu::new(mtm);
    let item = unsafe {
        menu.addItemWithTitle_action_keyEquivalent(
            &NSString::from_str("New window"),
            Some(sel!(shireiNewWindow:)),
            &NSString::from_str(""),
        )
    };
    unsafe { item.setTarget(Some(&*this)) };
    Retained::autorelease_return(menu)
}

extern "C" fn new_window(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
    if let Some(app) = APP.get()
        && let Err(e) = crate::open_window(app)
    {
        log::error!("dock menu: failed to open window: {e}");
    }
}
