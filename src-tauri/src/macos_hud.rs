#[cfg(target_os = "macos")]
use std::cell::RefCell;

#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSFont, NSLineBreakMode, NSPanel,
    NSTextAlignment, NSTextField, NSView, NSWindowCollectionBehavior, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use objc2_quartz_core::CALayer;

#[cfg(target_os = "macos")]
const HUD_WIDTH: f64 = 208.0;
#[cfg(target_os = "macos")]
const HUD_HEIGHT: f64 = 44.0;

#[cfg(target_os = "macos")]
thread_local! {
    static HUD: RefCell<Option<NativeHud>> = const { RefCell::new(None) };
}

#[cfg(target_os = "macos")]
struct NativeHud {
    panel: Retained<NSPanel>,
    label: Retained<NSTextField>,
}

#[cfg(target_os = "macos")]
impl NativeHud {
    fn new(mtm: MainThreadMarker) -> Self {
        let style = NSWindowStyleMask(
            NSWindowStyleMask::Borderless.0 | NSWindowStyleMask::NonactivatingPanel.0,
        );
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(HUD_WIDTH, HUD_HEIGHT));
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
            NSPanel::alloc(mtm),
            frame,
            style,
            NSBackingStoreType::Buffered,
            false,
        );

        let content = NSView::initWithFrame(NSView::alloc(mtm), frame);
        content.setWantsLayer(true);
        let label_frame = NSRect::new(
            NSPoint::new(14.0, 8.0),
            NSSize::new(HUD_WIDTH - 28.0, HUD_HEIGHT - 16.0),
        );
        let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
        label.setFrame(label_frame);
        label.setDrawsBackground(false);
        label.setBordered(false);
        label.setBezeled(false);
        label.setEditable(false);
        label.setSelectable(false);
        label.setMaximumNumberOfLines(1);
        label.setUsesSingleLineMode(true);
        label.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        label.setAlignment(NSTextAlignment::Center);
        label.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
        label.setTextColor(Some(&NSColor::colorWithWhite_alpha(1.0, 0.96)));

        content.addSubview(&label);

        panel.setContentView(Some(&content));
        panel.setFloatingPanel(true);
        panel.setBecomesKeyOnlyIfNeeded(true);
        panel.setWorksWhenModal(true);
        panel.setMovable(false);
        panel.setMovableByWindowBackground(false);
        panel.setHidesOnDeactivate(false);
        panel.setCanHide(false);
        panel.setOpaque(false);
        panel.setHasShadow(true);
        panel.setAlphaValue(0.98);
        panel.setBackgroundColor(Some(&NSColor::colorWithWhite_alpha(0.0, 0.0)));
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::MoveToActiveSpace
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        panel.setLevel(NSFloatingWindowLevel);
        panel.setIgnoresMouseEvents(true);
        unsafe {
            panel.setReleasedWhenClosed(false);
        }

        if let Some(layer) = content.layer() {
            style_layer(&layer);
        }

        Self { panel, label }
    }

    fn show(&self, message: &str, frame: Option<(f64, f64, f64, f64)>) {
        self.label.setStringValue(&NSString::from_str(message));

        if let Some((window_x, window_y, window_width, window_height)) = frame {
            let x = window_x + (window_width - HUD_WIDTH) / 2.0;
            let y = window_y + window_height * 0.15;
            self.panel.setFrameOrigin(NSPoint::new(x, y));
        }

        self.panel.orderFront(None);
    }

    fn hide(&self) {
        self.panel.orderOut(None);
    }
}

#[cfg(target_os = "macos")]
fn style_layer(layer: &CALayer) {
    layer.setCornerRadius(14.0);
    layer.setMasksToBounds(true);
    let fill = NSColor::colorWithWhite_alpha(0.12, 0.82);
    let cg_fill = fill.CGColor();
    layer.setBackgroundColor(Some(&cg_fill));
}

#[cfg(target_os = "macos")]
pub fn show(message: &str, frame: Option<(f64, f64, f64, f64)>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    HUD.with(|slot| {
        let mut slot = slot.borrow_mut();
        let hud = slot.get_or_insert_with(|| NativeHud::new(mtm));
        hud.show(message, frame);
    });
}

#[cfg(target_os = "macos")]
pub fn hide() {
    let Some(_mtm) = MainThreadMarker::new() else {
        return;
    };

    HUD.with(|slot| {
        if let Some(hud) = slot.borrow().as_ref() {
            hud.hide();
        }
    });
}
