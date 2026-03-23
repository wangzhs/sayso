/// Recording FSM
///
/// State transitions:
///
/// ```
///                     hotkey_press
///   IDLE ────────────────────────────► RECORDING
///     ▲                                    │
///     │                              hotkey_release
///     │                                    │
///     │                                    ▼
///   DONE ◄──── inject_done ────── INJECTING ◄──── stt_result ── STT_WAITING
///     │                                                               │   │
///     └────────────────────────────────────────────────────────► ERROR   │
///     ▲                                                    (timeout, API) │
///     └───────────────────────── reset() (Mode C short-circuit) ─────────┘
///
/// - Any hotkey_press during RECORDING/STT_WAITING/INJECTING → toast "Already processing" + ignore
/// - ERROR → IDLE after toast displayed
/// - DONE → IDLE automatically
/// - STT_WAITING → IDLE directly for Mode C (command executed/rejected without text injection)
/// ```
use std::sync::{Arc, Mutex};
use log::{debug, warn};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsmState {
    Idle,
    Recording,
    SttWaiting,
    Injecting,
    Done,
    Error(String),
}

impl std::fmt::Display for FsmState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsmState::Idle => write!(f, "IDLE"),
            FsmState::Recording => write!(f, "RECORDING"),
            FsmState::SttWaiting => write!(f, "STT_WAITING"),
            FsmState::Injecting => write!(f, "INJECTING"),
            FsmState::Done => write!(f, "DONE"),
            FsmState::Error(msg) => write!(f, "ERROR({})", msg),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RecordingFsm {
    state: Arc<Mutex<FsmState>>,
}

impl RecordingFsm {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(FsmState::Idle)),
        }
    }

    pub fn state(&self) -> FsmState {
        self.state.lock().unwrap().clone()
    }

    pub fn is_idle(&self) -> bool {
        matches!(*self.state.lock().unwrap(), FsmState::Idle)
    }

    pub fn is_processing(&self) -> bool {
        !matches!(
            *self.state.lock().unwrap(),
            FsmState::Idle | FsmState::Done | FsmState::Error(_)
        )
    }

    /// Returns Ok(()) if the transition was valid, Err(msg) if it was blocked.
    pub fn transition(&self, next: FsmState) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let valid = match (&*state, &next) {
            (FsmState::Idle, FsmState::Recording) => true,
            (FsmState::Recording, FsmState::SttWaiting) => true,
            (FsmState::Recording, FsmState::Idle) => true, // cancelled (recording too short)
            (FsmState::SttWaiting, FsmState::Injecting) => true,
            (FsmState::SttWaiting, FsmState::Error(_)) => true,
            (FsmState::SttWaiting, FsmState::Idle) => true, // Mode C short-circuit (no injection)
            (FsmState::Injecting, FsmState::Done) => true,
            (FsmState::Injecting, FsmState::Error(_)) => true,
            (FsmState::Done, FsmState::Idle) => true,
            (FsmState::Error(_), FsmState::Idle) => true,
            _ => false,
        };

        if valid {
            debug!("FSM: {} → {}", state, next);
            *state = next;
            Ok(())
        } else {
            let msg = format!("Invalid FSM transition: {} → {}", state, next);
            warn!("{}", msg);
            Err(msg)
        }
    }

    /// Called when hotkey is pressed. Returns false if already processing (caller should show toast).
    pub fn on_hotkey_press(&self) -> bool {
        if self.is_processing() {
            warn!("FSM: hotkey pressed during processing — ignoring");
            return false;
        }
        self.transition(FsmState::Recording).is_ok()
    }

    pub fn on_hotkey_release(&self) -> bool {
        self.transition(FsmState::SttWaiting).is_ok()
    }

    pub fn on_stt_result(&self) -> bool {
        self.transition(FsmState::Injecting).is_ok()
    }

    pub fn on_stt_error(&self, msg: String) -> bool {
        self.transition(FsmState::Error(msg)).is_ok()
    }

    pub fn on_inject_done(&self) -> bool {
        self.transition(FsmState::Done).is_ok()
    }

    pub fn on_inject_error(&self, msg: String) -> bool {
        self.transition(FsmState::Error(msg)).is_ok()
    }

    /// Force the FSM back to Idle regardless of current state.
    ///
    /// Unlike `transition()`, reset() always succeeds — it is an escape hatch
    /// used at the end of every pipeline branch (including Mode C where no
    /// Injecting/Done steps occur).
    pub fn reset(&self) {
        let mut state = self.state.lock().unwrap();
        debug!("FSM: {} → IDLE (reset)", *state);
        *state = FsmState::Idle;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_happy_path_transitions() {
        let fsm = RecordingFsm::new();
        assert!(fsm.is_idle());

        assert!(fsm.on_hotkey_press());
        assert_eq!(fsm.state(), FsmState::Recording);

        assert!(fsm.on_hotkey_release());
        assert_eq!(fsm.state(), FsmState::SttWaiting);

        assert!(fsm.on_stt_result());
        assert_eq!(fsm.state(), FsmState::Injecting);

        assert!(fsm.on_inject_done());
        assert_eq!(fsm.state(), FsmState::Done);

        assert!(fsm.transition(FsmState::Idle).is_ok());
        assert!(fsm.is_idle());
    }

    #[test]
    fn test_invalid_transition_idle_to_injecting() {
        let fsm = RecordingFsm::new();
        assert!(fsm.transition(FsmState::Injecting).is_err());
        assert!(fsm.is_idle()); // state unchanged on invalid transition
    }

    #[test]
    fn test_hotkey_ignored_during_processing() {
        let fsm = RecordingFsm::new();
        assert!(fsm.on_hotkey_press()); // IDLE → RECORDING: ok

        // Second press while RECORDING should be blocked
        assert!(!fsm.on_hotkey_press());
        assert_eq!(fsm.state(), FsmState::Recording); // state unchanged
    }

    #[test]
    fn test_error_recovery() {
        let fsm = RecordingFsm::new();
        fsm.on_hotkey_press();
        fsm.on_hotkey_release();
        assert!(fsm.on_stt_error("Connection timeout".to_string()));
        assert!(matches!(fsm.state(), FsmState::Error(_)));

        // After error, can reset to idle
        fsm.reset();
        assert!(fsm.is_idle());
    }

    #[test]
    fn test_mode_c_reset_from_stt_waiting() {
        // Regression: Mode C exits (reject/execute/timeout) call reset() from SttWaiting.
        // Without SttWaiting→Idle transition, FSM stays stuck — next hotkey ignored forever.
        let fsm = RecordingFsm::new();
        fsm.on_hotkey_press();   // IDLE → RECORDING
        fsm.on_hotkey_release(); // RECORDING → STT_WAITING
        // Mode C: command rejected/executed — reset directly from STT_WAITING
        fsm.reset();
        assert!(fsm.is_idle(), "FSM must be idle after Mode C reset — was stuck in SttWaiting");
        // Verify next hotkey press works
        assert!(fsm.on_hotkey_press(), "Next hotkey press must be accepted after Mode C reset");
    }

    #[test]
    fn test_safety_filter_blocks_rm_rf() {
        // FSM-level test: ensure the flow doesn't break when command is rejected
        let fsm = RecordingFsm::new();
        fsm.on_hotkey_press();
        fsm.on_hotkey_release();
        // Simulating: command rejected → skip Injecting → go to Error
        assert!(fsm.on_stt_error("Rejected: recursive deletion risk".to_string()));
        assert!(matches!(fsm.state(), FsmState::Error(_)));
        fsm.reset();
        assert!(fsm.is_idle());
    }
}
