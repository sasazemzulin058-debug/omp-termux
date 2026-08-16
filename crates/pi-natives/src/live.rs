//! N-API bindings for the Codex live WebRTC peer.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! the realtime peer, Opus media, and speaker playback live in
//! `pi_voice::live`. This class adapts its callbacks to non-blocking
//! threadsafe functions and its PCM input to `Float32Array`.
//!
//! On Android/Termux the WebRTC/opus graph is stubbed out of the native addon
//! so CI can build arm64 without OOM-killing the runner.

use napi::{
	bindgen_prelude::{Float32Array, Result},
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;

type StringCallback = ThreadsafeFunction<String, UnknownReturnValue>;
type LevelCallback = ThreadsafeFunction<f64, UnknownReturnValue>;

/// WebRTC peer that accepts 16 kHz mono PCM and renders remote Opus audio.
#[cfg(not(target_os = "android"))]
#[napi]
pub struct LiveWebRtcPeer {
	inner: std::sync::Arc<pi_voice::live::LivePeerCore>,
}

#[cfg(not(target_os = "android"))]
#[napi]
impl LiveWebRtcPeer {
	/// Create an idle peer and register its event, output-level, and failure
	/// callbacks.
	#[napi(constructor)]
	pub fn new(
		#[napi(ts_arg_type = "(error: Error | null, payload: string) => void")]
		on_event: StringCallback,
		#[napi(ts_arg_type = "(error: Error | null, level: number) => void")] on_level: LevelCallback,
		#[napi(ts_arg_type = "(error: Error | null, message: string) => void")]
		on_failure: StringCallback,
	) -> Self {
		use napi::threadsafe_function::ThreadsafeFunctionCallMode;
		use pi_voice::live::{LiveCallbacks, LivePeerCore};

		Self {
			inner: std::sync::Arc::new(LivePeerCore::new(LiveCallbacks {
				event:   Box::new(move |payload| {
					on_event.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
				}),
				level:   Box::new(move |level| {
					on_level.call(Ok(level), ThreadsafeFunctionCallMode::NonBlocking);
				}),
				failure: Box::new(move |message| {
					on_failure.call(Ok(message), ThreadsafeFunctionCallMode::NonBlocking);
				}),
			})),
		}
	}

	/// Start the native media peer and return its SDP offer.
	#[napi]
	pub async fn create_offer(&self) -> Result<String> {
		self
			.inner
			.create_offer()
			.await
			.map_err(napi::Error::from_reason)
	}

	/// Apply the remote SDP answer returned by Codex signaling.
	#[napi]
	pub async fn accept_answer(&self, sdp: String) -> Result<()> {
		self
			.inner
			.accept_answer(sdp)
			.await
			.map_err(napi::Error::from_reason)
	}

	/// Wait until the `oai-events` data channel is open.
	#[napi]
	pub async fn wait_for_open(&self, timeout_ms: Option<u32>) -> Result<()> {
		use pi_voice::live::DEFAULT_OPEN_TIMEOUT_MS;

		self
			.inner
			.wait_for_open(timeout_ms.unwrap_or(DEFAULT_OPEN_TIMEOUT_MS))
			.await
			.map_err(napi::Error::from_reason)
	}

	/// Queue 16 kHz mono floating-point PCM for Opus transmission.
	#[napi]
	pub fn push_audio(&self, samples: Float32Array) -> Result<()> {
		self
			.inner
			.push_audio(&samples)
			.map_err(napi::Error::from_reason)
	}

	/// Enable or disable microphone transmission, discarding partial muted
	/// frames.
	#[napi]
	pub fn set_muted(&self, muted: bool) -> Result<()> {
		self
			.inner
			.set_muted(muted)
			.map_err(napi::Error::from_reason)
	}

	/// Close media, the data channel, the peer connection, and speaker playback.
	#[napi]
	pub async fn close(&self) {
		self.inner.close().await;
	}
}

#[cfg(not(target_os = "android"))]
impl Drop for LiveWebRtcPeer {
	fn drop(&mut self) {
		if self.inner.is_closing() {
			return;
		}
		let inner = std::sync::Arc::clone(&self.inner);
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			runtime.spawn(async move {
				inner.close().await;
			});
		}
	}
}

// ─── Android/Termux stubs (no pi-voice / webrtc / opus graph) ───────────────

const ANDROID_LIVE_MSG: &str =
	"LiveWebRtcPeer is not supported on Android/Termux arm64 build (pi-voice/webrtc stubbed to fit CI memory)";

/// WebRTC peer — stubbed on Android.
#[cfg(target_os = "android")]
#[napi]
pub struct LiveWebRtcPeer;

#[cfg(target_os = "android")]
#[napi]
impl LiveWebRtcPeer {
	/// Always constructs, but every media op fails with a clear Termux message.
	#[napi(constructor)]
	pub fn new(
		#[napi(ts_arg_type = "(error: Error | null, payload: string) => void")]
		_on_event: StringCallback,
		#[napi(ts_arg_type = "(error: Error | null, level: number) => void")]
		_on_level: LevelCallback,
		#[napi(ts_arg_type = "(error: Error | null, message: string) => void")]
		_on_failure: StringCallback,
	) -> Self {
		Self
	}

	#[napi]
	pub async fn create_offer(&self) -> Result<String> {
		Err(napi::Error::from_reason(ANDROID_LIVE_MSG))
	}

	#[napi]
	pub async fn accept_answer(&self, _sdp: String) -> Result<()> {
		Err(napi::Error::from_reason(ANDROID_LIVE_MSG))
	}

	#[napi]
	pub async fn wait_for_open(&self, _timeout_ms: Option<u32>) -> Result<()> {
		Err(napi::Error::from_reason(ANDROID_LIVE_MSG))
	}

	#[napi]
	pub fn push_audio(&self, _samples: Float32Array) -> Result<()> {
		Err(napi::Error::from_reason(ANDROID_LIVE_MSG))
	}

	#[napi]
	pub fn set_muted(&self, _muted: bool) -> Result<()> {
		Err(napi::Error::from_reason(ANDROID_LIVE_MSG))
	}

	#[napi]
	pub async fn close(&self) {}
}
