use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("PTY session not found: {0}")]
    SessionNotFound(String),
    #[error("{0}")]
    Pty(String),
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("cannot open file (binary or too large): {0}")]
    Unreadable(String),
    #[error("file changed on disk since it was opened: {0}")]
    WriteConflict(String),
    #[error("content exceeds the configured size limit: {0}")]
    TooLarge(String),
    #[error("config error: {0}")]
    Config(String),
    #[error("system action failed: {0}")]
    Os(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("zip error: {0}")]
    Zip(String),
    #[error("invalid font file: {0}")]
    InvalidFont(String),
    #[error("screen recording permission denied")]
    ScreencastPermissionDenied,
    #[error("screen recording unsupported on this macOS version")]
    ScreencastUnsupported,
    #[error("recording failed: {0}")]
    Screencast(String),
    #[error("todo store error: {0}")]
    Db(String),
}

impl Error {
    /// Stable discriminant for the frontend; human-readable messages can be
    /// reworded or localized without breaking callers that branch on errors.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Io(_) => "io",
            Error::SessionNotFound(_) => "session-not-found",
            Error::Pty(_) => "pty",
            Error::NotFound(_) => "not-found",
            Error::Unreadable(_) => "unreadable",
            Error::WriteConflict(_) => "write-conflict",
            Error::TooLarge(_) => "too-large",
            Error::Config(_) => "config",
            Error::Os(_) => "os",
            Error::Network(_) => "network",
            Error::Zip(_) => "zip",
            Error::InvalidFont(_) => "invalid-font",
            Error::ScreencastPermissionDenied => "screencast-permission-denied",
            Error::ScreencastUnsupported => "screencast-unsupported",
            Error::Screencast(_) => "screencast",
            Error::Db(_) => "db",
        }
    }
}

impl From<anyhow::Error> for Error {
    fn from(err: anyhow::Error) -> Self {
        Error::Pty(err.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() {
        let err = Error::WriteConflict("/tmp/file".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "write-conflict");
        assert!(json["message"].as_str().unwrap().contains("/tmp/file"));
    }

    #[test]
    fn every_variant_has_a_distinct_code() {
        let codes = [
            Error::Io(std::io::Error::other("x")).code(),
            Error::SessionNotFound(String::new()).code(),
            Error::Pty(String::new()).code(),
            Error::NotFound(String::new()).code(),
            Error::Unreadable(String::new()).code(),
            Error::WriteConflict(String::new()).code(),
            Error::TooLarge(String::new()).code(),
            Error::Config(String::new()).code(),
            Error::Os(String::new()).code(),
            Error::Network(String::new()).code(),
            Error::Zip(String::new()).code(),
            Error::InvalidFont(String::new()).code(),
            Error::ScreencastPermissionDenied.code(),
            Error::ScreencastUnsupported.code(),
            Error::Screencast(String::new()).code(),
            Error::Db(String::new()).code(),
        ];
        let unique: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len());
    }
}
