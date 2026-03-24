use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    thread,
};

use core_foundation::runloop::CFRunLoop;
use core_graphics::event::{
    CallbackResult, CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventType, KeyCode,
};
use log::warn;

use crate::{config, error::SaysoError};

const KEYBOARD_EVENT_AUTOREPEAT_FIELD: u32 = 8;
const KEYBOARD_EVENT_KEYCODE_FIELD: u32 = 9;

#[derive(Clone)]
struct HotkeySpec {
    mode: char,
    specific: Vec<u16>,
    any_of: Vec<Vec<u16>>,
}

impl HotkeySpec {
    fn logical_len(&self) -> usize {
        self.specific.len() + self.any_of.len()
    }

    fn is_single_key(&self) -> bool {
        self.logical_len() == 1
    }

    fn matches(&self, pressed: &HashSet<u16>) -> bool {
        if !self.specific.iter().all(|code| pressed.contains(code)) {
            return false;
        }

        if !self
            .any_of
            .iter()
            .all(|group| group.iter().any(|code| pressed.contains(code)))
        {
            return false;
        }

        let allowed: HashSet<u16> = self
            .specific
            .iter()
            .copied()
            .chain(self.any_of.iter().flatten().copied())
            .collect();

        pressed.iter().all(|code| allowed.contains(code))
    }
}

pub struct MacHotkeyEngine {
    specs: Arc<RwLock<Vec<HotkeySpec>>>,
}

pub fn validate_config(cfg: &config::AppConfig) -> Result<(), SaysoError> {
    parse_hotkeys(cfg).map(|_| ())
}

impl MacHotkeyEngine {
    pub fn new<FPress, FRelease>(
        cfg: &config::AppConfig,
        on_press: FPress,
        on_release: FRelease,
    ) -> Result<Self, SaysoError>
    where
        FPress: Fn(char, bool) + Send + Sync + 'static,
        FRelease: Fn(char, bool) + Send + Sync + 'static,
    {
        let specs = Arc::new(RwLock::new(parse_hotkeys(cfg)?));
        let thread_specs = Arc::clone(&specs);
        let thread_on_press = Arc::new(on_press);
        let thread_on_release = Arc::new(on_release);

        thread::spawn(move || {
            let pressed = Arc::new(Mutex::new(HashSet::<u16>::new()));
            let active = Arc::new(Mutex::new(HashMap::<char, bool>::new()));

            let tap = CGEventTap::new(
                CGEventTapLocation::HID,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::KeyDown, CGEventType::KeyUp, CGEventType::FlagsChanged],
                move |_proxy, event_type, event| {
                    if let Some(keycode) = event_keycode(event) {
                        let specs = thread_specs.read().unwrap().clone();
                        let tracked: HashSet<u16> = specs
                            .iter()
                            .flat_map(|spec| {
                                spec.specific
                                    .iter()
                                    .copied()
                                    .chain(spec.any_of.iter().flatten().copied())
                            })
                            .collect();

                        if !tracked.contains(&keycode) {
                            return CallbackResult::Keep;
                        }

                        if matches!(event_type, CGEventType::KeyDown)
                            && event.get_integer_value_field(KEYBOARD_EVENT_AUTOREPEAT_FIELD) != 0
                        {
                            return CallbackResult::Keep;
                        }

                        let snapshot = {
                            let mut pressed = pressed.lock().unwrap();
                            match event_type {
                                CGEventType::KeyDown => {
                                    pressed.insert(keycode);
                                }
                                CGEventType::KeyUp => {
                                    pressed.remove(&keycode);
                                }
                                CGEventType::FlagsChanged => {
                                    if modifier_is_down(event, keycode) {
                                        pressed.insert(keycode);
                                    } else {
                                        pressed.remove(&keycode);
                                    }
                                }
                                _ => {}
                            }
                            pressed.clone()
                        };

                        let mut active = active.lock().unwrap();

                        for spec in &specs {
                            let matched = spec.matches(&snapshot);
                            let was_active = active.get(&spec.mode).copied().unwrap_or(false);

                            if matched != was_active {
                                active.insert(spec.mode, matched);
                                if matched {
                                    thread_on_press(spec.mode, spec.is_single_key());
                                } else {
                                    thread_on_release(spec.mode, spec.is_single_key());
                                }
                            }
                        }
                    }

                    CallbackResult::Keep
                },
            );

            match tap {
                Ok(event_tap) => {
                    let source = event_tap
                        .mach_port()
                        .create_runloop_source(0)
                        .expect("Failed to create hotkey runloop source");
                    CFRunLoop::get_current().add_source(&source, unsafe {
                        core_foundation::runloop::kCFRunLoopCommonModes
                    });
                    event_tap.enable();
                    CFRunLoop::run_current();
                }
                Err(_) => {
                    warn!("Failed to install macOS hotkey event tap");
                }
            }
        });

        Ok(Self { specs })
    }

    pub fn update_config(&self, cfg: &config::AppConfig) -> Result<(), SaysoError> {
        let next = parse_hotkeys(cfg)?;
        *self.specs.write().unwrap() = next;
        Ok(())
    }
}

fn event_keycode(event: &CGEvent) -> Option<u16> {
    let keycode = event.get_integer_value_field(KEYBOARD_EVENT_KEYCODE_FIELD);
    u16::try_from(keycode).ok()
}

fn modifier_is_down(event: &CGEvent, keycode: u16) -> bool {
    let flags = event.get_flags();
    match keycode {
        code if code == KeyCode::OPTION => flags.contains(CGEventFlags::CGEventFlagAlternate),
        code if code == KeyCode::RIGHT_OPTION => flags.contains(CGEventFlags::CGEventFlagAlternate),
        code if code == KeyCode::SHIFT => flags.contains(CGEventFlags::CGEventFlagShift),
        code if code == KeyCode::RIGHT_SHIFT => flags.contains(CGEventFlags::CGEventFlagShift),
        code if code == KeyCode::CONTROL => flags.contains(CGEventFlags::CGEventFlagControl),
        code if code == KeyCode::RIGHT_CONTROL => flags.contains(CGEventFlags::CGEventFlagControl),
        code if code == KeyCode::COMMAND => flags.contains(CGEventFlags::CGEventFlagCommand),
        code if code == KeyCode::RIGHT_COMMAND => flags.contains(CGEventFlags::CGEventFlagCommand),
        _ => false,
    }
}

fn parse_hotkeys(cfg: &config::AppConfig) -> Result<Vec<HotkeySpec>, SaysoError> {
    [
        (cfg.hotkeys.mode_a.as_str(), 'a'),
        (cfg.hotkeys.mode_b.as_str(), 'b'),
        (cfg.hotkeys.mode_c.as_str(), 'c'),
    ]
    .into_iter()
    .map(|(value, mode)| parse_hotkey(value, mode))
    .collect()
}

fn parse_hotkey(value: &str, mode: char) -> Result<HotkeySpec, SaysoError> {
    let mut specific = Vec::new();
    let mut any_of = Vec::new();

    for raw in value.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(SaysoError::Other(format!("Invalid shortcut '{}'", value)));
        }

        match parse_token(token)? {
            ParsedToken::Specific(code) => specific.push(code),
            ParsedToken::Any(group) => any_of.push(group),
        }
    }

    Ok(HotkeySpec {
        mode,
        specific,
        any_of,
    })
}

enum ParsedToken {
    Specific(u16),
    Any(Vec<u16>),
}

fn parse_token(token: &str) -> Result<ParsedToken, SaysoError> {
    let upper = token.trim().to_uppercase();
    let specific = match upper.as_str() {
        "OPTIONLEFT" | "LEFTOPTION" | "ALTLEFT" | "LEFTALT" => Some(KeyCode::OPTION),
        "OPTIONRIGHT" | "RIGHTOPTION" | "ALTRIGHT" | "RIGHTALT" => Some(KeyCode::RIGHT_OPTION),
        "SHIFTLEFT" | "LEFTSHIFT" => Some(KeyCode::SHIFT),
        "SHIFTRIGHT" | "RIGHTSHIFT" => Some(KeyCode::RIGHT_SHIFT),
        "CONTROLLEFT" | "LEFTCONTROL" | "CTRLLEFT" | "LEFTCTRL" => Some(KeyCode::CONTROL),
        "CONTROLRIGHT" | "RIGHTCONTROL" | "CTRLRIGHT" | "RIGHTCTRL" => Some(KeyCode::RIGHT_CONTROL),
        "COMMANDLEFT" | "LEFTCOMMAND" | "CMDLEFT" | "LEFTCMD" | "SUPERLEFT" | "LEFTSUPER" => {
            Some(KeyCode::COMMAND)
        }
        "COMMANDRIGHT" | "RIGHTCOMMAND" | "CMDRIGHT" | "RIGHTCMD" | "SUPERRIGHT" | "RIGHTSUPER" => {
            Some(KeyCode::RIGHT_COMMAND)
        }
        "SPACE" => Some(KeyCode::SPACE),
        "ENTER" => Some(KeyCode::RETURN),
        "TAB" => Some(KeyCode::TAB),
        "BACKSPACE" => Some(KeyCode::DELETE),
        "DELETE" => Some(KeyCode::FORWARD_DELETE),
        "ESCAPE" | "ESC" => Some(KeyCode::ESCAPE),
        "UP" | "ARROWUP" => Some(KeyCode::UP_ARROW),
        "DOWN" | "ARROWDOWN" => Some(KeyCode::DOWN_ARROW),
        "LEFT" | "ARROWLEFT" => Some(KeyCode::LEFT_ARROW),
        "RIGHT" | "ARROWRIGHT" => Some(KeyCode::RIGHT_ARROW),
        "HOME" => Some(KeyCode::HOME),
        "END" => Some(KeyCode::END),
        "PAGEUP" => Some(KeyCode::PAGE_UP),
        "PAGEDOWN" => Some(KeyCode::PAGE_DOWN),
        "PERIOD" | "." => Some(KeyCode::ANSI_PERIOD),
        "COMMA" | "," => Some(KeyCode::ANSI_COMMA),
        "SLASH" | "/" => Some(KeyCode::ANSI_SLASH),
        "SEMICOLON" | ";" => Some(KeyCode::ANSI_SEMICOLON),
        "QUOTE" | "'" => Some(KeyCode::ANSI_QUOTE),
        "BACKSLASH" | "\\" => Some(KeyCode::ANSI_BACKSLASH),
        "BACKQUOTE" | "`" => Some(KeyCode::ANSI_GRAVE),
        "MINUS" | "-" => Some(KeyCode::ANSI_MINUS),
        "EQUAL" | "=" => Some(KeyCode::ANSI_EQUAL),
        "BRACKETLEFT" | "[" => Some(KeyCode::ANSI_LEFT_BRACKET),
        "BRACKETRIGHT" | "]" => Some(KeyCode::ANSI_RIGHT_BRACKET),
        "F1" => Some(KeyCode::F1),
        "F2" => Some(KeyCode::F2),
        "F3" => Some(KeyCode::F3),
        "F4" => Some(KeyCode::F4),
        "F5" => Some(KeyCode::F5),
        "F6" => Some(KeyCode::F6),
        "F7" => Some(KeyCode::F7),
        "F8" => Some(KeyCode::F8),
        "F9" => Some(KeyCode::F9),
        "F10" => Some(KeyCode::F10),
        "F11" => Some(KeyCode::F11),
        "F12" => Some(KeyCode::F12),
        "A" => Some(KeyCode::ANSI_A),
        "B" => Some(KeyCode::ANSI_B),
        "C" => Some(KeyCode::ANSI_C),
        "D" => Some(KeyCode::ANSI_D),
        "E" => Some(KeyCode::ANSI_E),
        "F" => Some(KeyCode::ANSI_F),
        "G" => Some(KeyCode::ANSI_G),
        "H" => Some(KeyCode::ANSI_H),
        "I" => Some(KeyCode::ANSI_I),
        "J" => Some(KeyCode::ANSI_J),
        "K" => Some(KeyCode::ANSI_K),
        "L" => Some(KeyCode::ANSI_L),
        "M" => Some(KeyCode::ANSI_M),
        "N" => Some(KeyCode::ANSI_N),
        "O" => Some(KeyCode::ANSI_O),
        "P" => Some(KeyCode::ANSI_P),
        "Q" => Some(KeyCode::ANSI_Q),
        "R" => Some(KeyCode::ANSI_R),
        "S" => Some(KeyCode::ANSI_S),
        "T" => Some(KeyCode::ANSI_T),
        "U" => Some(KeyCode::ANSI_U),
        "V" => Some(KeyCode::ANSI_V),
        "W" => Some(KeyCode::ANSI_W),
        "X" => Some(KeyCode::ANSI_X),
        "Y" => Some(KeyCode::ANSI_Y),
        "Z" => Some(KeyCode::ANSI_Z),
        "0" => Some(KeyCode::ANSI_0),
        "1" => Some(KeyCode::ANSI_1),
        "2" => Some(KeyCode::ANSI_2),
        "3" => Some(KeyCode::ANSI_3),
        "4" => Some(KeyCode::ANSI_4),
        "5" => Some(KeyCode::ANSI_5),
        "6" => Some(KeyCode::ANSI_6),
        "7" => Some(KeyCode::ANSI_7),
        "8" => Some(KeyCode::ANSI_8),
        "9" => Some(KeyCode::ANSI_9),
        _ => None,
    };

    if let Some(code) = specific {
        return Ok(ParsedToken::Specific(code));
    }

    let any = match upper.as_str() {
        "OPTION" | "ALT" => Some(vec![KeyCode::OPTION, KeyCode::RIGHT_OPTION]),
        "SHIFT" => Some(vec![KeyCode::SHIFT, KeyCode::RIGHT_SHIFT]),
        "CONTROL" | "CTRL" => Some(vec![KeyCode::CONTROL, KeyCode::RIGHT_CONTROL]),
        "COMMAND" | "CMD" | "SUPER" => Some(vec![KeyCode::COMMAND, KeyCode::RIGHT_COMMAND]),
        _ => None,
    };

    if let Some(group) = any {
        return Ok(ParsedToken::Any(group));
    }

    Err(SaysoError::Other(format!("Invalid shortcut token '{}'", token)))
}
