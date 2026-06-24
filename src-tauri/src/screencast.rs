#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};
use crate::fs::expand_tilde;

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RecordMode {
    Panel,
    App,
    Region,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct PhysicalRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub mode: RecordMode,
    pub rect: Option<PhysicalRect>,
    pub format: crate::config::RecordFormat,
    pub out_path: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct StopResult {
    pub path: String,
}

#[derive(Default)]
pub struct RecorderState(pub Mutex<Option<ActiveRecording>>);

pub struct ActiveRecording {
    capture: imp::Capture,
    stop_flag: Arc<AtomicBool>,
}

fn should_sample(last_emitted_ms: Option<u64>, frame_ms: u64, period_ms: u64) -> bool {
    match last_emitted_ms {
        None => true,
        // admit a frame ~1ms early so integer-truncated periods don't systematically drop frames
        Some(prev) => frame_ms.saturating_sub(prev) + 1 >= period_ms,
    }
}

pub fn ensure_permission() -> Result<()> {
    imp::ensure_permission()
}

#[tauri::command]
pub fn screencast_start(
    app: AppHandle,
    state: State<'_, RecorderState>,
    config: State<'_, crate::config::ConfigManager>,
    args: StartArgs,
) -> Result<String> {
    ensure_permission()?;

    {
        let guard = state
            .0
            .lock()
            .map_err(|e| Error::Screencast(e.to_string()))?;
        if guard.is_some() {
            return Err(Error::Screencast(
                "a recording is already in progress".into(),
            ));
        }
    }

    let recorder = config.current().recorder;
    let scale = app
        .get_webview_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let crop = match args.mode {
        RecordMode::Region | RecordMode::Panel => args.rect,
        RecordMode::App => None,
    };
    let target = imp::CaptureTarget {
        rect: crop,
        format: args.format,
        fps: recorder.fps.max(1) as i32,
        gif_fps: recorder.gif_fps.max(1) as u32,
        gif_max_width: recorder.gif_max_width,
        show_cursor: recorder.show_cursor,
        max_duration_secs: recorder.max_duration_secs,
        scale,
    };

    let out = expand_tilde(&args.out_path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(Error::Io)?;
    }
    let out_path = out.to_string_lossy().into_owned();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let capture = imp::Capture::start(&out_path, &target)?;

    let id = format!("cast-{}", std::process::id().wrapping_add(id_suffix()));

    *state
        .0
        .lock()
        .map_err(|e| Error::Screencast(e.to_string()))? = Some(ActiveRecording {
        capture,
        stop_flag: stop_flag.clone(),
    });

    spawn_timer(app.clone(), stop_flag, recorder.max_duration_secs);

    let _ = app.emit("screencast://started", &id);
    Ok(id)
}

#[tauri::command]
pub fn screencast_stop(app: AppHandle, state: State<'_, RecorderState>) -> Result<StopResult> {
    let active = state
        .0
        .lock()
        .map_err(|e| Error::Screencast(e.to_string()))?
        .take()
        .ok_or_else(|| Error::Screencast("no recording in progress".into()))?;

    active.stop_flag.store(true, Ordering::SeqCst);
    let res = StopResult {
        path: active.capture.finish()?,
    };
    let _ = app.emit("screencast://stopped", &res);
    Ok(res)
}

#[tauri::command]
pub fn screencast_cancel(state: State<'_, RecorderState>) -> Result<()> {
    let active = state
        .0
        .lock()
        .map_err(|e| Error::Screencast(e.to_string()))?
        .take();
    if let Some(active) = active {
        active.stop_flag.store(true, Ordering::SeqCst);
        active.capture.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn screencast_copy_to_clipboard(app: AppHandle, path: String) -> Result<()> {
    let path = expand_tilde(&path).to_string_lossy().into_owned();
    run_on_main(&app, move || imp::copy_file_to_clipboard(&path))
}

#[tauri::command]
pub fn screencast_share(app: AppHandle, path: String) -> Result<()> {
    let path = expand_tilde(&path).to_string_lossy().into_owned();
    let app2 = app.clone();
    run_on_main(&app, move || imp::share_file(&app2, &path))
}

fn run_on_main<F>(app: &AppHandle, work: F) -> Result<()>
where
    F: FnOnce() -> Result<()> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<()>>(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|e| Error::Os(e.to_string()))?;
    rx.recv()
        .map_err(|e| Error::Os(format!("main-thread task did not complete: {e}")))?
}

fn spawn_timer(app: AppHandle, stop_flag: Arc<AtomicBool>, max_duration_secs: u32) {
    std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            if stop_flag.load(Ordering::SeqCst) {
                return;
            }
            let elapsed_ms = start.elapsed().as_millis() as u64;
            let _ = app.emit("screencast://tick", elapsed_ms);
            if max_duration_secs > 0 && elapsed_ms >= max_duration_secs as u64 * 1000 {
                if let Some(state) = app.try_state::<RecorderState>() {
                    let active = state.0.lock().ok().and_then(|mut g| g.take());
                    if let Some(active) = active {
                        active.stop_flag.store(true, Ordering::SeqCst);
                        if let Ok(path) = active.capture.finish() {
                            let _ = app.emit("screencast://stopped", &StopResult { path });
                        }
                    }
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

fn id_suffix() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

mod imp {
    use super::*;

    use std::sync::mpsc::sync_channel;

    use block2::RcBlock;
    use dispatch2::{DispatchQueue, DispatchQueueAttr};
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_av_foundation::{
        AVAssetWriter, AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeVideo,
        AVVideoCodecKey, AVVideoCodecTypeH264, AVVideoHeightKey, AVVideoWidthKey,
    };
    use objc2_core_foundation::{
        CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CFType, CGRect,
    };
    use objc2_core_image::{CIContext, CIImage};
    use objc2_core_media::{CMSampleBuffer, CMTime};
    use objc2_core_video::{
        CVImageBuffer, CVPixelBuffer, CVPixelBufferGetHeight, CVPixelBufferGetWidth,
    };
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSURL};
    use objc2_image_io::{
        CGImageDestination, kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFDictionary,
        kCGImagePropertyGIFLoopCount,
    };
    use objc2_screen_capture_kit::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
        SCStreamOutputType, SCWindow,
    };

    pub fn ensure_permission() -> Result<()> {
        use objc2_core_graphics::CGRequestScreenCaptureAccess;
        // CGPreflightScreenCaptureAccess caches `false` for the whole process
        // life — per Apple DTS it only flips to true after a relaunch — so gating
        // every start on it re-fires the system dialog forever (the grant never
        // "takes" in-session). SCShareableContent instead reflects the live TCC
        // state, so use it as the gate and fire the request dialog at most once
        // per session; the grant only applies on the next launch.
        match shareable_content() {
            Ok(_) => Ok(()),
            Err(Error::ScreencastPermissionDenied) => {
                static REQUESTED: AtomicBool = AtomicBool::new(false);
                if !REQUESTED.swap(true, Ordering::SeqCst) {
                    CGRequestScreenCaptureAccess();
                }
                Err(Error::ScreencastPermissionDenied)
            }
            Err(e) => Err(e),
        }
    }

    pub struct CaptureTarget {
        pub rect: Option<PhysicalRect>,
        pub format: crate::config::RecordFormat,
        pub fps: i32,
        pub gif_fps: u32,
        pub gif_max_width: u32,
        pub show_cursor: bool,
        pub max_duration_secs: u32,
        pub scale: f64,
    }

    enum Sink {
        Mp4(Mp4Encoder),
        Gif(GifEncoder),
    }

    struct Shared {
        sink: Mutex<Sink>,
        cancelled: AtomicBool,
    }

    unsafe impl Send for Shared {}
    unsafe impl Sync for Shared {}

    struct Ivars {
        shared: Arc<Shared>,
    }

    define_class!(
        // SAFETY:
        // - The superclass NSObject has no subclassing requirements.
        // - `StreamOutput` does not implement `Drop`.
        #[unsafe(super(NSObject))]
        #[ivars = Ivars]
        struct StreamOutput;

        unsafe impl NSObjectProtocol for StreamOutput {}

        unsafe impl SCStreamOutput for StreamOutput {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_did_output(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                ty: SCStreamOutputType,
            ) {
                if ty != SCStreamOutputType::Screen {
                    return;
                }
                let shared = &self.ivars().shared;
                if shared.cancelled.load(Ordering::SeqCst) {
                    return;
                }
                let mut sink = match shared.sink.lock() {
                    Ok(s) => s,
                    Err(_) => return,
                };
                match &mut *sink {
                    Sink::Mp4(enc) => enc.append(sample_buffer),
                    Sink::Gif(enc) => enc.append(sample_buffer),
                };
            }
        }
    );

    impl StreamOutput {
        fn new(shared: Arc<Shared>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars { shared });
            unsafe { msg_send![super(this), init] }
        }
    }

    pub struct Capture {
        stream: Retained<SCStream>,
        _output: Retained<StreamOutput>,
        _queue: dispatch2::DispatchRetained<DispatchQueue>,
        shared: Arc<Shared>,
        out_path: String,
    }

    unsafe impl Send for Capture {}

    impl Capture {
        pub fn start(out_path: &str, target: &CaptureTarget) -> Result<Self> {
            let window = app_window()?;
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            let config = build_config(&window, target);

            let sink = match target.format {
                crate::config::RecordFormat::Mp4 => {
                    let (w, h) = config_dims(&config);
                    Sink::Mp4(Mp4Encoder::new(out_path, w, h)?)
                }
                crate::config::RecordFormat::Gif => Sink::Gif(GifEncoder::new(
                    target.gif_fps,
                    target.gif_max_width,
                    target.max_duration_secs,
                )),
            };

            let shared = Arc::new(Shared {
                sink: Mutex::new(sink),
                cancelled: AtomicBool::new(false),
            });

            let output = StreamOutput::new(shared.clone());
            let stream = unsafe {
                SCStream::initWithFilter_configuration_delegate(
                    SCStream::alloc(),
                    &filter,
                    &config,
                    None,
                )
            };

            let queue = DispatchQueue::new("io.bstr.shirei.screencast", DispatchQueueAttr::SERIAL);
            let proto = ProtocolObject::from_ref(&*output);
            unsafe {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(
                        proto,
                        SCStreamOutputType::Screen,
                        Some(&queue),
                    )
                    .map_err(|e| Error::Screencast(ns_error_message(&e)))?;
            }

            block_on_completion(|done| unsafe {
                stream.startCaptureWithCompletionHandler(Some(&done));
            })?;

            Ok(Capture {
                stream,
                _output: output,
                _queue: queue,
                shared,
                out_path: out_path.to_string(),
            })
        }

        pub fn finish(self) -> Result<String> {
            let stream = self.stream;
            let _ = block_on_completion(|done| unsafe {
                stream.stopCaptureWithCompletionHandler(Some(&done));
            });

            let mut sink = self
                .shared
                .sink
                .lock()
                .map_err(|e| Error::Screencast(e.to_string()))?;
            match &mut *sink {
                Sink::Mp4(enc) => enc.finish(&self.out_path),
                Sink::Gif(enc) => enc.finish(&self.out_path),
            }
        }

        pub fn cancel(self) {
            self.shared.cancelled.store(true, Ordering::SeqCst);
            let stream = self.stream;
            let _ = block_on_completion(|done| unsafe {
                stream.stopCaptureWithCompletionHandler(Some(&done));
            });
            let _ = std::fs::remove_file(&self.out_path);
        }
    }

    fn config_dims(config: &SCStreamConfiguration) -> (usize, usize) {
        unsafe { (config.width(), config.height()) }
    }

    fn build_config(window: &SCWindow, target: &CaptureTarget) -> Retained<SCStreamConfiguration> {
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setShowsCursor(target.show_cursor);
            config.setMinimumFrameInterval(CMTime {
                value: 1,
                timescale: target.fps,
                flags: objc2_core_media::CMTimeFlags(1),
                epoch: 0,
            });
            let frame = window.frame();
            match target.rect {
                Some(r) => {
                    config.setWidth(r.width as usize);
                    config.setHeight(r.height as usize);
                    // sourceRect is in points (window space); width/height are output pixels.
                    config.setSourceRect(CGRect {
                        origin: objc2_core_foundation::CGPoint {
                            x: r.x as f64 / target.scale,
                            y: r.y as f64 / target.scale,
                        },
                        size: objc2_core_foundation::CGSize {
                            width: r.width as f64 / target.scale,
                            height: r.height as f64 / target.scale,
                        },
                    });
                }
                None => {
                    config.setWidth((frame.size.width * target.scale).round().max(2.0) as usize);
                    config.setHeight((frame.size.height * target.scale).round().max(2.0) as usize);
                }
            }
        }
        config
    }

    fn app_window() -> Result<Retained<SCWindow>> {
        let content = shareable_content()?;
        let windows = unsafe { content.windows() };
        let pid = std::process::id() as libc::pid_t;
        let bundle_id = main_bundle_id();

        let mut fallback: Option<Retained<SCWindow>> = None;
        for window in windows.iter() {
            let owner = match unsafe { window.owningApplication() } {
                Some(o) => o,
                None => continue,
            };
            let matches_pid = unsafe { owner.processID() } == pid;
            let matches_bundle = bundle_id
                .as_deref()
                .map(|b| unsafe { owner.bundleIdentifier() }.to_string() == b)
                .unwrap_or(false);
            if !(matches_pid || matches_bundle) {
                continue;
            }
            if unsafe { window.windowLayer() } != 0 {
                continue;
            }
            let frame = unsafe { window.frame() };
            if frame.size.width < 1.0 || frame.size.height < 1.0 {
                continue;
            }
            let area = frame.size.width * frame.size.height;
            let prev_area = fallback
                .as_ref()
                .map(|w| {
                    let f = unsafe { w.frame() };
                    f.size.width * f.size.height
                })
                .unwrap_or(0.0);
            if area >= prev_area {
                fallback = Some(window);
            }
        }
        fallback
            .ok_or_else(|| Error::Screencast("could not locate the app window to capture".into()))
    }

    fn main_bundle_id() -> Option<String> {
        let bundle = objc2_foundation::NSBundle::mainBundle();
        bundle.bundleIdentifier().map(|s| s.to_string())
    }

    struct SendPtr(*mut SCShareableContent);
    unsafe impl Send for SendPtr {}

    fn shareable_content() -> Result<Retained<SCShareableContent>> {
        let (tx, rx) = sync_channel::<std::result::Result<SendPtr, String>>(1);
        let tx = Arc::new(Mutex::new(Some(tx)));
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if !content.is_null() {
                    Ok(SendPtr(
                        unsafe { Retained::retain(content) }
                            .map(Retained::into_raw)
                            .unwrap_or(std::ptr::null_mut()),
                    ))
                } else if !error.is_null() {
                    Err(unsafe { (*error).localizedDescription() }.to_string())
                } else {
                    Err("unknown ScreenCaptureKit error".to_string())
                };
                if let Ok(mut guard) = tx.lock()
                    && let Some(sender) = guard.take()
                {
                    let _ = sender.send(result);
                }
            },
        );
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&handler);
        }
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(ptr)) => unsafe { Retained::from_raw(ptr.0) }.ok_or(Error::ScreencastUnsupported),
            Ok(Err(msg)) => {
                if msg.to_lowercase().contains("declined")
                    || msg.to_lowercase().contains("permission")
                {
                    Err(Error::ScreencastPermissionDenied)
                } else {
                    Err(Error::ScreencastUnsupported)
                }
            }
            Err(_) => Err(Error::ScreencastUnsupported),
        }
    }

    fn block_on_completion<F>(invoke: F) -> Result<()>
    where
        F: FnOnce(RcBlock<dyn Fn(*mut NSError)>),
    {
        let (tx, rx) = sync_channel::<Option<String>>(1);
        let tx = Arc::new(Mutex::new(Some(tx)));
        let handler = RcBlock::new(move |error: *mut NSError| {
            let msg = if error.is_null() {
                None
            } else {
                Some(unsafe { (*error).localizedDescription() }.to_string())
            };
            if let Ok(mut guard) = tx.lock()
                && let Some(sender) = guard.take()
            {
                let _ = sender.send(msg);
            }
        });
        invoke(handler);
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(None) => Ok(()),
            Ok(Some(msg)) => Err(Error::Screencast(msg)),
            Err(_) => Err(Error::Screencast("capture operation timed out".into())),
        }
    }

    fn block_on_void<F>(invoke: F)
    where
        F: FnOnce(RcBlock<dyn Fn()>),
    {
        let (tx, rx) = sync_channel::<()>(1);
        let tx = Arc::new(Mutex::new(Some(tx)));
        let handler = RcBlock::new(move || {
            if let Ok(mut guard) = tx.lock()
                && let Some(sender) = guard.take()
            {
                let _ = sender.send(());
            }
        });
        invoke(handler);
        let _ = rx.recv_timeout(Duration::from_secs(15));
    }

    fn ns_error_message(err: &NSError) -> String {
        err.localizedDescription().to_string()
    }

    struct Mp4Encoder {
        writer: Retained<AVAssetWriter>,
        input: Retained<AVAssetWriterInput>,
        started: bool,
    }

    impl Mp4Encoder {
        fn new(out_path: &str, width: usize, height: usize) -> Result<Self> {
            let _ = std::fs::remove_file(out_path);
            let url = NSURL::fileURLWithPath(&NSString::from_str(out_path));
            let file_type = unsafe { AVFileTypeMPEG4 }
                .ok_or_else(|| Error::Screencast("AVFileTypeMPEG4 unavailable".into()))?;
            let writer = unsafe {
                AVAssetWriter::initWithURL_fileType_error(AVAssetWriter::alloc(), &url, file_type)
            }
            .map_err(|e| Error::Screencast(ns_error_message(&e)))?;

            let codec_key = unsafe { AVVideoCodecKey }
                .ok_or_else(|| Error::Screencast("AVVideoCodecKey unavailable".into()))?;
            let codec = unsafe { AVVideoCodecTypeH264 }
                .ok_or_else(|| Error::Screencast("AVVideoCodecTypeH264 unavailable".into()))?;
            let width_key = unsafe { AVVideoWidthKey }
                .ok_or_else(|| Error::Screencast("AVVideoWidthKey unavailable".into()))?;
            let height_key = unsafe { AVVideoHeightKey }
                .ok_or_else(|| Error::Screencast("AVVideoHeightKey unavailable".into()))?;

            let keys: [&NSString; 3] = [codec_key, width_key, height_key];
            let w_num = NSNumber::numberWithUnsignedInteger(width);
            let h_num = NSNumber::numberWithUnsignedInteger(height);
            let codec_obj: &objc2::runtime::AnyObject = codec.as_ref();
            let values: [&objc2::runtime::AnyObject; 3] =
                [codec_obj, w_num.as_ref(), h_num.as_ref()];
            let settings: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> =
                NSDictionary::from_slices(&keys, &values);

            let media_type = unsafe { AVMediaTypeVideo }
                .ok_or_else(|| Error::Screencast("AVMediaTypeVideo unavailable".into()))?;
            let input = unsafe {
                AVAssetWriterInput::initWithMediaType_outputSettings(
                    AVAssetWriterInput::alloc(),
                    media_type,
                    Some(&settings),
                )
            };
            unsafe {
                input.setExpectsMediaDataInRealTime(true);
                if !writer.canAddInput(&input) {
                    return Err(Error::Screencast(
                        "AVAssetWriter rejected the video input".into(),
                    ));
                }
                writer.addInput(&input);
            }
            Ok(Mp4Encoder {
                writer,
                input,
                started: false,
            })
        }

        fn append(&mut self, sample_buffer: &CMSampleBuffer) -> bool {
            unsafe {
                if !self.started {
                    if !self.writer.startWriting() {
                        return false;
                    }
                    let pts = sample_buffer.presentation_time_stamp();
                    self.writer.startSessionAtSourceTime(pts);
                    self.started = true;
                }
                if !self.input.isReadyForMoreMediaData() {
                    return false;
                }
                self.input.appendSampleBuffer(sample_buffer)
            }
        }

        fn finish(&mut self, out_path: &str) -> Result<String> {
            if !self.started {
                let _ = std::fs::remove_file(out_path);
                return Err(Error::Screencast("empty recording".into()));
            }
            unsafe { self.input.markAsFinished() };
            block_on_void(|done| unsafe { self.writer.finishWritingWithCompletionHandler(&done) });
            let status = unsafe { self.writer.status() };
            if status == AVAssetWriterStatus::Failed
                || std::fs::metadata(out_path).map(|m| m.len()).unwrap_or(0) == 0
            {
                let _ = std::fs::remove_file(out_path);
                return Err(Error::Screencast("empty recording".into()));
            }
            Ok(out_path.to_string())
        }
    }

    const GIF_HARD_CAP_SECS: u32 = 600;

    struct GifEncoder {
        context: Retained<CIContext>,
        frames: Vec<Retained<objc2_core_graphics::CGImage>>,
        delay: f64,
        max_width: u32,
        max_frames: usize,
        period_ms: u64,
        last_emitted_ms: Option<u64>,
        base_pts_ms: Option<u64>,
    }

    impl GifEncoder {
        fn new(gif_fps: u32, gif_max_width: u32, max_duration_secs: u32) -> Self {
            let fps = gif_fps.max(1);
            // max_duration_secs == 0 means "until the user stops", but GIF frames
            // are full CGImages held in memory, so cap regardless: an unattended
            // recording must not grow the heap without bound.
            let secs = if max_duration_secs > 0 {
                max_duration_secs.min(GIF_HARD_CAP_SECS)
            } else {
                GIF_HARD_CAP_SECS
            };
            let max_frames = (secs as usize) * (fps as usize) + 4;
            GifEncoder {
                context: unsafe { CIContext::context() },
                frames: Vec::new(),
                delay: 1.0 / fps as f64,
                max_width: gif_max_width,
                max_frames,
                period_ms: (1000 / fps as u64).max(1),
                last_emitted_ms: None,
                base_pts_ms: None,
            }
        }

        fn append(&mut self, sample_buffer: &CMSampleBuffer) -> bool {
            if self.frames.len() >= self.max_frames {
                return false;
            }
            let pts = unsafe { sample_buffer.presentation_time_stamp() };
            let pts_ms = cmtime_ms(pts);
            let base = *self.base_pts_ms.get_or_insert(pts_ms);
            let rel_ms = pts_ms.saturating_sub(base);
            if !should_sample(self.last_emitted_ms, rel_ms, self.period_ms) {
                return false;
            }

            let image_buffer = match unsafe { sample_buffer.image_buffer() } {
                Some(b) => b,
                None => return false,
            };
            let pixel_buffer: &CVPixelBuffer = unsafe { cast_image_buffer(&image_buffer) };
            let src_w = CVPixelBufferGetWidth(pixel_buffer) as f64;
            let src_h = CVPixelBufferGetHeight(pixel_buffer) as f64;
            if src_w < 1.0 || src_h < 1.0 {
                return false;
            }

            let ci = unsafe { CIImage::imageWithCVPixelBuffer(pixel_buffer) };
            let scale = if self.max_width > 0 && src_w > self.max_width as f64 {
                self.max_width as f64 / src_w
            } else {
                1.0
            };
            let scaled = if scale < 1.0 {
                unsafe { scale_ci_image(&ci, scale) }
            } else {
                ci
            };
            let extent = unsafe { scaled.extent() };
            let cg = match unsafe { self.context.createCGImage_fromRect(&scaled, extent) } {
                Some(img) => img,
                None => return false,
            };
            self.frames.push(cg);
            self.last_emitted_ms = Some(rel_ms);
            true
        }

        fn finish(&mut self, out_path: &str) -> Result<String> {
            if self.frames.is_empty() {
                let _ = std::fs::remove_file(out_path);
                return Err(Error::Screencast("empty recording".into()));
            }
            let _ = std::fs::remove_file(out_path);
            let url = NSURL::fileURLWithPath(&NSString::from_str(out_path));
            let cf_url: &objc2_core_foundation::CFURL = unsafe { cast_nsurl(&url) };
            let gif_uti = CFString::from_str("com.compuserve.gif");

            let dest =
                unsafe { CGImageDestination::with_url(cf_url, &gif_uti, self.frames.len(), None) }
                    .ok_or_else(|| Error::Screencast("failed to create GIF destination".into()))?;

            let gif_dict_key = unsafe { kCGImagePropertyGIFDictionary };
            let loop_key = unsafe { kCGImagePropertyGIFLoopCount };
            let delay_key = unsafe { kCGImagePropertyGIFDelayTime };

            let zero = cf_number_i32(0);
            let loop_val: &CFType = &zero;
            let loop_dict: CFRetained<CFDictionary<CFString, CFType>> =
                CFDictionary::from_slices(&[loop_key], &[loop_val]);
            let loop_dict_val: &CFType = &loop_dict;
            let file_props: CFRetained<CFDictionary<CFString, CFType>> =
                CFDictionary::from_slices(&[gif_dict_key], &[loop_dict_val]);
            unsafe { dest.set_properties(Some(file_props.as_ref())) };

            let delay = cf_number_f64(self.delay);
            let delay_val: &CFType = &delay;
            let frame_gif_dict: CFRetained<CFDictionary<CFString, CFType>> =
                CFDictionary::from_slices(&[delay_key], &[delay_val]);
            let frame_gif_dict_val: &CFType = &frame_gif_dict;
            let frame_props: CFRetained<CFDictionary<CFString, CFType>> =
                CFDictionary::from_slices(&[gif_dict_key], &[frame_gif_dict_val]);

            for frame in &self.frames {
                unsafe { dest.add_image(frame, Some(frame_props.as_ref())) };
            }
            let finalized = unsafe { dest.finalize() };
            if !finalized {
                let _ = std::fs::remove_file(out_path);
                return Err(Error::Screencast("failed to finalize GIF".into()));
            }
            Ok(out_path.to_string())
        }
    }

    fn cmtime_ms(t: CMTime) -> u64 {
        if t.timescale == 0 {
            return 0;
        }
        ((t.value as i128 * 1000) / t.timescale as i128).max(0) as u64
    }

    fn cf_number_i32(value: i32) -> CFRetained<CFNumber> {
        let v = value;
        unsafe {
            CFNumber::new(None, CFNumberType::SInt32Type, &v as *const i32 as *const _)
                .expect("CFNumberCreate returned null")
        }
    }

    fn cf_number_f64(value: f64) -> CFRetained<CFNumber> {
        let v = value;
        unsafe {
            CFNumber::new(
                None,
                CFNumberType::Float64Type,
                &v as *const f64 as *const _,
            )
            .expect("CFNumberCreate returned null")
        }
    }

    unsafe fn cast_image_buffer(buf: &CVImageBuffer) -> &CVPixelBuffer {
        // SAFETY: CVImageBuffer and CVPixelBuffer are the same opaque CF type (CVPixelBufferRef is a CVImageBufferRef).
        unsafe { &*(buf as *const CVImageBuffer as *const CVPixelBuffer) }
    }

    pub fn copy_file_to_clipboard(path: &str) -> Result<()> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
        use objc2_foundation::NSArray;

        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let writer: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*url);
        let items = NSArray::from_slice(&[writer]);

        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if !pasteboard.writeObjects(&items) {
            return Err(Error::Os(
                "could not write the file to the clipboard".into(),
            ));
        }
        Ok(())
    }

    pub fn share_file(app: &AppHandle, path: &str) -> Result<()> {
        use objc2_app_kit::{NSSharingServicePicker, NSView, NSWindow};
        use objc2_foundation::{NSArray, NSRectEdge};

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| Error::Os("main window not found".into()))?;
        let ns_window = window.ns_window().map_err(|e| Error::Os(e.to_string()))?;
        if ns_window.is_null() {
            return Err(Error::Os("could not access the native window".into()));
        }
        // SAFETY: Tauri returns the window's NSWindow pointer; valid while the window lives.
        let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        let view: Retained<NSView> = ns_window
            .contentView()
            .ok_or_else(|| Error::Os("window has no content view".into()))?;

        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let url_obj: &objc2::runtime::AnyObject = url.as_ref();
        let items: Retained<NSArray> = NSArray::from_slice(&[url_obj]);

        // SAFETY: NSURL conforms to NSPasteboardWriting, the item type initWithItems requires.
        let picker = unsafe {
            NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
        };
        let bounds = view.bounds();
        picker.showRelativeToRect_ofView_preferredEdge(bounds, &view, NSRectEdge::MinY);
        Ok(())
    }

    unsafe fn cast_nsurl(url: &NSURL) -> &objc2_core_foundation::CFURL {
        // SAFETY: NSURL and CFURL are toll-free bridged, so the pointer is valid as either type.
        unsafe { &*(url as *const NSURL as *const objc2_core_foundation::CFURL) }
    }

    unsafe fn scale_ci_image(image: &CIImage, scale: f64) -> Retained<CIImage> {
        let matrix = objc2_core_foundation::CGAffineTransform {
            a: scale,
            b: 0.0,
            c: 0.0,
            d: scale,
            tx: 0.0,
            ty: 0.0,
        };
        unsafe { image.imageByApplyingTransform(matrix) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_tilde() {
        unsafe { std::env::set_var("HOME", "/Users/test") };
        assert_eq!(
            expand_tilde("~/Movies/Shirei/a.mp4"),
            std::path::PathBuf::from("/Users/test/Movies/Shirei/a.mp4")
        );
        assert_eq!(expand_tilde("~"), std::path::PathBuf::from("/Users/test"));
        assert_eq!(
            expand_tilde("/abs/path.gif"),
            std::path::PathBuf::from("/abs/path.gif")
        );
    }

    #[test]
    fn samples_first_frame_then_by_period() {
        assert!(should_sample(None, 0, 66));
        assert!(!should_sample(Some(0), 30, 66));
        assert!(should_sample(Some(0), 66, 66));
        assert!(should_sample(Some(0), 100, 66));
        assert!(!should_sample(Some(66), 100, 66));
        assert!(should_sample(Some(66), 132, 66));
    }
}
