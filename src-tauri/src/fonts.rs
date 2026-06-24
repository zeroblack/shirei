use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{ConfigManager, FontKind};
use crate::error::{Error, Result};

/// Implementations must return an error (never panic) when `start` is past the
/// end, and callers must not assume the returned buffer is exactly `len` bytes:
/// an HTTP range can legally answer with fewer. Downstream parsing guards its
/// own bounds so a short read degrades to an error.
pub trait RangeReader {
    fn len(&self) -> Result<u64>;
    fn read_range(&self, start: u64, len: u64) -> Result<Vec<u8>>;
}

const EOCD_SIG: u32 = 0x0605_4b50;
const CD_SIG: u32 = 0x0201_4b50;
const LFH_SIG: u32 = 0x0403_4b50;
const EOCD_MIN: u64 = 22;
// 32-bit offsets only: Nerd Fonts release assets are < 4GB, so no ZIP64. The
// 64KB tail finds the EOCD because those assets carry an empty zip comment.
const TAIL_SCAN: u64 = 64 * 1024;
// Caps decompression so a malformed or hostile zip entry can't expand without
// bound (zip bomb). The largest Nerd Font we ship is ~10 MiB.
const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;

struct CdEntry {
    name: String,
    method: u16,
    compressed_size: u64,
    local_offset: u64,
}

fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32le(b: &[u8], o: usize) -> u64 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as u64
}

fn find_eocd(tail: &[u8]) -> Result<usize> {
    if tail.len() < EOCD_MIN as usize {
        return Err(Error::Zip("file too small for EOCD".into()));
    }
    let max = tail.len() - EOCD_MIN as usize;
    for i in (0..=max).rev() {
        if u32le(tail, i) as u32 == EOCD_SIG {
            return Ok(i);
        }
    }
    Err(Error::Zip("EOCD not found".into()))
}

fn parse_central_directory(cd: &[u8]) -> Result<Vec<CdEntry>> {
    let mut entries = Vec::new();
    let mut o = 0usize;
    while o + 46 <= cd.len() {
        if u32le(cd, o) as u32 != CD_SIG {
            break;
        }
        let method = u16le(cd, o + 10);
        let compressed_size = u32le(cd, o + 20);
        let name_len = u16le(cd, o + 28) as usize;
        let extra_len = u16le(cd, o + 30) as usize;
        let comment_len = u16le(cd, o + 32) as usize;
        let local_offset = u32le(cd, o + 42);
        let name_start = o + 46;
        if name_start + name_len > cd.len() {
            break;
        }
        let name = String::from_utf8_lossy(&cd[name_start..name_start + name_len]).into_owned();
        entries.push(CdEntry {
            name,
            method,
            compressed_size,
            local_offset,
        });
        o = name_start + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

fn matches_pattern(name: &str, pattern: &str) -> bool {
    let file = name.rsplit('/').next().unwrap_or(name);
    match pattern.strip_prefix('*') {
        Some(suffix) => file.ends_with(suffix),
        None => file == pattern,
    }
}

const SFNT_EXTS: [&str; 2] = [".ttf", ".otf"];

// Nerd Fonts ships some families as .otf only (Geist Mono, Commit Mono) while
// most are .ttf, so a pattern naming one sfnt extension must also match its
// sibling — the catalog should not have to know each font's on-disk format.
fn sibling_sfnt_pattern(pattern: &str) -> Option<String> {
    let i = SFNT_EXTS.iter().position(|ext| pattern.ends_with(ext))?;
    let other = SFNT_EXTS[(i + 1) % SFNT_EXTS.len()];
    Some(format!(
        "{}{other}",
        &pattern[..pattern.len() - SFNT_EXTS[i].len()]
    ))
}

fn find_font_entry<'a>(entries: &'a [CdEntry], pattern: &str) -> Option<&'a CdEntry> {
    entries
        .iter()
        .find(|e| matches_pattern(&e.name, pattern))
        .or_else(|| {
            let alt = sibling_sfnt_pattern(pattern)?;
            entries.iter().find(|e| matches_pattern(&e.name, &alt))
        })
}

fn inflate_entry(
    local_header_and_data: &[u8],
    method: u16,
    compressed_size: u64,
) -> Result<Vec<u8>> {
    if local_header_and_data.len() < 30 {
        return Err(Error::Zip("local header truncated".into()));
    }
    if u32le(local_header_and_data, 0) as u32 != LFH_SIG {
        return Err(Error::Zip("bad local file header".into()));
    }
    let name_len = u16le(local_header_and_data, 26) as usize;
    let extra_len = u16le(local_header_and_data, 28) as usize;
    let data_start = 30 + name_len + extra_len;
    let end = data_start + compressed_size as usize;
    if end > local_header_and_data.len() {
        return Err(Error::Zip("compressed data out of range".into()));
    }
    let data = &local_header_and_data[data_start..end];
    match method {
        0 => Ok(data.to_vec()),
        8 => {
            use flate2::read::DeflateDecoder;
            use std::io::Read;
            let mut out = Vec::new();
            DeflateDecoder::new(data)
                .take(MAX_FONT_BYTES + 1)
                .read_to_end(&mut out)
                .map_err(|e| Error::Zip(format!("inflate failed: {e}")))?;
            if out.len() as u64 > MAX_FONT_BYTES {
                return Err(Error::Zip("inflated font exceeds size limit".into()));
            }
            Ok(out)
        }
        m => Err(Error::Zip(format!("unsupported compression method {m}"))),
    }
}

fn is_valid_sfnt(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(0..4),
        Some(b"\x00\x01\x00\x00") | Some(b"OTTO") | Some(b"true") | Some(b"ttcf")
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn extract_font<R: RangeReader>(reader: &R, pattern: &str) -> Result<Vec<u8>> {
    let total = reader.len()?;
    let tail_len = TAIL_SCAN.min(total);
    let tail = reader.read_range(total - tail_len, tail_len)?;
    let eocd = find_eocd(&tail)?;
    let cd_size = u32le(&tail, eocd + 12);
    let cd_offset = u32le(&tail, eocd + 16);
    let cd = reader.read_range(cd_offset, cd_size)?;
    let entries = parse_central_directory(&cd)?;
    let entry = find_font_entry(&entries, pattern)
        .ok_or_else(|| Error::Zip(format!("no entry matching {pattern}")))?;
    let chunk_len = 30 + 4096 + entry.compressed_size;
    let chunk = reader.read_range(
        entry.local_offset,
        chunk_len.min(total - entry.local_offset),
    )?;
    let font = inflate_entry(&chunk, entry.method, entry.compressed_size)?;
    if !is_valid_sfnt(&font) {
        return Err(Error::InvalidFont("not an sfnt font".into()));
    }
    Ok(font)
}

const NERD_FONTS_BASE: &str = "https://github.com/ryanoasis/nerd-fonts/releases/download";

struct HttpRangeReader {
    client: reqwest::blocking::Client,
    url: String,
}

impl RangeReader for HttpRangeReader {
    fn len(&self) -> Result<u64> {
        let resp = self
            .client
            .head(&self.url)
            .send()
            .map_err(|e| Error::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(Error::Network(format!(
                "HEAD {}: {}",
                self.url,
                resp.status()
            )));
        }
        resp.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| Error::Network("missing content-length".into()))
    }

    fn read_range(&self, start: u64, len: u64) -> Result<Vec<u8>> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let end = start + len - 1;
        let resp = self
            .client
            .get(&self.url)
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send()
            .map_err(|e| Error::Network(e.to_string()))?;
        if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(Error::Network(format!(
                "range not honored: {}",
                resp.status()
            )));
        }
        resp.bytes()
            .map(|b| b.to_vec())
            .map_err(|e| Error::Network(e.to_string()))
    }
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    id: String,
    phase: String,
}

fn emit_progress(app: &AppHandle, id: &str, phase: &str) {
    let _ = app.emit(
        "font-install-progress",
        InstallProgress {
            id: id.into(),
            phase: phase.into(),
        },
    );
}

fn fonts_dir(app: &AppHandle) -> Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Os(e.to_string()))?
        .join("fonts");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// The id is joined into a filesystem path; reject anything that isn't a bare
// catalog identifier so it can't escape the fonts dir (path traversal).
fn ensure_safe_id(id: &str) -> Result<()> {
    let safe = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if safe {
        Ok(())
    } else {
        Err(Error::NotFound(format!("font {id}")))
    }
}

#[tauri::command]
pub async fn font_install(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    id: String,
) -> Result<()> {
    let (asset, pattern, tag, expected_sha) = {
        let cfg = manager.current();
        let entry = cfg
            .fonts
            .catalog
            .iter()
            .find(|e| e.id == id && e.kind == FontKind::Download)
            .ok_or_else(|| Error::NotFound(format!("downloadable font {id}")))?;
        (
            entry
                .asset
                .clone()
                .ok_or_else(|| Error::Config("missing asset".into()))?,
            entry
                .glyph_pattern
                .clone()
                .unwrap_or_else(|| "*NerdFontMono-Regular.ttf".into()),
            cfg.fonts.release_tag.clone(),
            entry.sha256.clone(),
        )
    };

    // Blocking HTTP plus zip inflation can take seconds on a bad connection;
    // keep it off the IPC thread so keystrokes and resizes stay responsive.
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        emit_progress(&app, &id, "downloading");
        let url = format!("{NERD_FONTS_BASE}/{tag}/{asset}.zip");
        let reader = HttpRangeReader {
            client: reqwest::blocking::Client::builder()
                .build()
                .map_err(|e| Error::Network(e.to_string()))?,
            url,
        };
        let font = extract_font(&reader, &pattern)?;
        if let Some(expected) = &expected_sha {
            let actual = sha256_hex(&font);
            if &actual != expected {
                return Err(Error::InvalidFont(format!(
                    "checksum mismatch for {id}: expected {expected}, got {actual}"
                )));
            }
        }

        emit_progress(&app, &id, "writing");
        let dir = fonts_dir(&app)?;
        let tmp = dir.join(format!("{id}.ttf.tmp"));
        let final_path = dir.join(format!("{id}.ttf"));
        std::fs::write(&tmp, &font)?;
        std::fs::rename(&tmp, &final_path)?;

        emit_progress(&app, &id, "done");
        Ok(())
    })
    .await
    .map_err(|e| Error::Os(e.to_string()))?
}

#[tauri::command]
pub fn font_installed(app: AppHandle) -> Result<Vec<String>> {
    let dir = fonts_dir(&app)?;
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".ttf") {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

#[tauri::command]
pub fn font_read(app: AppHandle, id: String) -> Result<Vec<u8>> {
    ensure_safe_id(&id)?;
    let path = fonts_dir(&app)?.join(format!("{id}.ttf"));
    std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(format!("font {id}")),
        _ => e.into(),
    })
}

#[tauri::command]
pub fn font_remove(app: AppHandle, id: String) -> Result<()> {
    ensure_safe_id(&id)?;
    let path = fonts_dir(&app)?.join(format!("{id}.ttf"));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct MemReader(Vec<u8>);
    impl RangeReader for MemReader {
        fn len(&self) -> Result<u64> {
            Ok(self.0.len() as u64)
        }
        fn read_range(&self, start: u64, len: u64) -> Result<Vec<u8>> {
            let s = start as usize;
            let e = (start + len) as usize;
            Ok(self.0[s..e.min(self.0.len())].to_vec())
        }
    }

    fn build_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            w.start_file("noise/readme.txt", opts).unwrap();
            w.write_all(b"ignore me").unwrap();
            w.start_file("ttf/FiraCodeNerdFontMono-Regular.ttf", opts)
                .unwrap();
            let mut font = b"\x00\x01\x00\x00".to_vec();
            font.extend(std::iter::repeat_n(0x42u8, 2000));
            w.write_all(&font).unwrap();
            w.finish().unwrap();
        }
        buf
    }

    fn build_otf_only_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            w.start_file("otf/GeistMonoNerdFontMono-Regular.otf", opts)
                .unwrap();
            let mut font = b"OTTO".to_vec();
            font.extend(std::iter::repeat_n(0x42u8, 2000));
            w.write_all(&font).unwrap();
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn matches_pattern_suffix() {
        assert!(matches_pattern(
            "ttf/FiraCodeNerdFontMono-Regular.ttf",
            "*NerdFontMono-Regular.ttf"
        ));
        assert!(!matches_pattern(
            "ttf/FiraCodeNerdFont-Bold.ttf",
            "*NerdFontMono-Regular.ttf"
        ));
    }

    #[test]
    fn extracts_otf_when_pattern_requests_ttf() {
        let reader = MemReader(build_otf_only_zip());
        let font = extract_font(&reader, "*NerdFontMono-Regular.ttf").unwrap();
        assert_eq!(&font[0..4], b"OTTO");
    }

    #[test]
    fn prefers_ttf_when_both_extensions_present() {
        let reader = MemReader(build_zip());
        let font = extract_font(&reader, "*NerdFontMono-Regular.ttf").unwrap();
        assert_eq!(&font[0..4], b"\x00\x01\x00\x00");
    }

    #[test]
    fn extracts_target_font_from_zip() {
        let zip = build_zip();
        let reader = MemReader(zip);
        let font = extract_font(&reader, "*NerdFontMono-Regular.ttf").unwrap();
        assert_eq!(&font[0..4], b"\x00\x01\x00\x00");
        assert_eq!(font.len(), 4 + 2000);
    }

    #[test]
    fn missing_pattern_errors() {
        let reader = MemReader(build_zip());
        let err = extract_font(&reader, "*DoesNotExist.ttf").unwrap_err();
        assert_eq!(err.code(), "zip");
    }

    #[test]
    fn truncated_local_header_errors_without_panic() {
        let err = inflate_entry(&[0u8; 10], 8, 0).unwrap_err();
        assert_eq!(err.code(), "zip");
    }

    #[test]
    fn safe_id_accepts_catalog_ids_rejects_traversal() {
        for id in ["meslo", "firacode", "0xproto", "geist-mono", "a_b"] {
            assert!(ensure_safe_id(id).is_ok());
        }
        for id in ["", "../etc/passwd", "a/b", "a\\b", "..", "foo.bar"] {
            assert!(ensure_safe_id(id).is_err());
        }
    }

    #[test]
    #[ignore = "hits the network; run manually with --ignored"]
    fn downloads_firacode_from_github() {
        let reader = HttpRangeReader {
            client: reqwest::blocking::Client::new(),
            url: "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/FiraCode.zip"
                .into(),
        };
        let font = extract_font(&reader, "*NerdFontMono-Regular.ttf").unwrap();
        assert!(font.len() > 100_000, "got {} bytes", font.len());
        assert_eq!(&font[0..4], b"\x00\x01\x00\x00");
    }
}
