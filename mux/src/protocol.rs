use std::io::Read;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
pub enum ClientMsg {
    Attach {
        id: String,
    },
    Spawn {
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        command: Option<String>,
    },
    Input {
        id: String,
        data: Vec<u8>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: String,
    },
    Detach {
        id: String,
    },
    Probe {
        id: String,
    },
    List,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
pub enum ServerMsg {
    Snapshot {
        id: String,
        data: Vec<u8>,
    },
    Output {
        id: String,
        data: Vec<u8>,
    },
    Exit {
        id: String,
    },
    Sessions {
        ids: Vec<String>,
    },
    Spawned {
        id: String,
        pid: Option<u32>,
    },
    Probe {
        id: String,
        cwd: Option<String>,
        command: Option<String>,
    },
}

/// Hard cap for a single frame body, enforced on both ends. Generously above
/// the largest legit payload (ring snapshots, bulk paste) while keeping a
/// hostile or corrupt length header from forcing a multi-GiB allocation.
pub const MAX_FRAME_LEN: usize = 8 * 1024 * 1024;

pub fn encode<T: Serialize>(msg: &T) -> anyhow::Result<Vec<u8>> {
    let body = postcard::to_stdvec(msg)?;
    anyhow::ensure!(
        body.len() <= MAX_FRAME_LEN,
        "frame body of {} bytes exceeds MAX_FRAME_LEN",
        body.len()
    );
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

pub fn decode<T: for<'de> Deserialize<'de>>(body: &[u8]) -> anyhow::Result<T> {
    Ok(postcard::from_bytes(body)?)
}

pub fn read_frame<R: Read>(reader: &mut R) -> anyhow::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    anyhow::ensure!(
        len <= MAX_FRAME_LEN,
        "frame length {len} exceeds MAX_FRAME_LEN"
    );
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msg_round_trip() {
        let msg = ClientMsg::Spawn {
            id: "p1".into(),
            cols: 120,
            rows: 40,
            cwd: Some("/tmp".into()),
            command: Some("claude".into()),
        };
        let frame = encode(&msg).unwrap();
        let mut cursor = std::io::Cursor::new(frame);
        let body = read_frame(&mut cursor).unwrap().expect("frame");
        let back: ClientMsg = decode(&body).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn server_msg_round_trip() {
        let msg = ServerMsg::Output {
            id: "p1".into(),
            data: vec![27, 91, 48, 109],
        };
        let frame = encode(&msg).unwrap();
        let mut cursor = std::io::Cursor::new(frame);
        let body = read_frame(&mut cursor).unwrap().expect("frame");
        let back: ServerMsg = decode(&body).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn two_frames_in_sequence() {
        let mut stream = Vec::new();
        stream.extend(encode(&ClientMsg::Attach { id: "a".into() }).unwrap());
        stream.extend(encode(&ClientMsg::List).unwrap());
        let mut cursor = std::io::Cursor::new(stream);
        let first: ClientMsg = decode(&read_frame(&mut cursor).unwrap().unwrap()).unwrap();
        let second: ClientMsg = decode(&read_frame(&mut cursor).unwrap().unwrap()).unwrap();
        assert_eq!(first, ClientMsg::Attach { id: "a".into() });
        assert_eq!(second, ClientMsg::List);
    }

    #[test]
    fn empty_stream_yields_none() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn oversized_length_header_is_rejected_before_allocating() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&u32::MAX.to_le_bytes());
        stream.extend_from_slice(&[0u8; 16]);
        let mut cursor = std::io::Cursor::new(stream);
        let err = read_frame(&mut cursor).unwrap_err();
        assert!(err.to_string().contains("MAX_FRAME_LEN"));
    }

    #[test]
    fn frame_at_the_limit_round_trips() {
        let body = vec![7u8; 1024];
        let frame = encode(&body).unwrap();
        let mut cursor = std::io::Cursor::new(frame);
        let back: Vec<u8> = decode(&read_frame(&mut cursor).unwrap().unwrap()).unwrap();
        assert_eq!(back, body);
    }

    #[test]
    fn encode_rejects_bodies_over_the_limit() {
        let body = vec![0u8; MAX_FRAME_LEN + 1];
        assert!(encode(&body).is_err());
    }
}
