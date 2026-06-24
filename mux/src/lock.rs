use std::sync::{Mutex, MutexGuard};

pub trait MutexExt<T> {
    /// Locks through poisoning: a panicked holder leaves stale-but-valid
    /// terminal state, which beats taking down the daemon or the app over it.
    fn lock_ignore_poison(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_ignore_poison(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}
