//! N-API bindings for microphone capture and speaker playback.
//!
//! The engine — device discovery, format conversion, mixing, drain semantics —
//! lives in `pi_voice::audio`; these classes adapt its mono `f32` contract to
//! TypeScript callbacks and `Float32Array` buffers.

#[cfg(not(target_os = "android"))]
use std::sync::Arc;

use napi::{
	bindgen_prelude::{Float32Array, Result},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
#[cfg(not(target_os = "android"))]
use parking_lot::Mutex;
#[cfg(not(target_os = "android"))]
use pi_voice::audio::{CaptureStream, PlaybackState, PlaybackStream};

#[cfg(not(target_os = "android"))]
type CaptureCallback = ThreadsafeFunction<Float32Array, UnknownReturnValue>;
#[cfg(target_os = "android")]
type CaptureCallback = ThreadsafeFunction<Float32Array, UnknownReturnValue>;

/// Default-microphone capture converted to mono `f32` at the requested sample
/// rate.
#[napi]
pub struct AudioCapture {
	#[cfg(not(target_os = "android"))]
	stream: Mutex<Option<CaptureStream>>,
}

#[cfg(not(target_os = "android"))]
#[napi]
impl AudioCapture {
	/// Open the default microphone and deliver low-latency mono PCM chunks.
	#[napi(constructor)]
	pub fn new(
		sample_rate: u32,
		#[napi(ts_arg_type = "(error: Error | null, samples: Float32Array) => void")]
		on_audio: CaptureCallback,
	) -> Result<Self> {
		let stream = CaptureStream::start(sample_rate, move |samples| {
			on_audio
				.call(Ok(Float32Array::new(samples.to_vec())), ThreadsafeFunctionCallMode::NonBlocking);
		})
		.map_err(napi::Error::from_reason)?;
		Ok(Self { stream: Mutex::new(Some(stream)) })
	}

	/// Stop capture immediately and release the microphone.
	#[napi]
	pub fn stop(&self) -> Result<()> {
		let stream = self.stream.lock().take();
		let Some(mut stream) = stream else {
			return Ok(());
		};
		stream.stop().map_err(napi::Error::from_reason)
	}
}

#[cfg(target_os = "android")]
#[napi]
impl AudioCapture {
	#[napi(constructor)]
	pub fn new(
		_sample_rate: u32,
		#[napi(ts_arg_type = "(error: Error | null, samples: Float32Array) => void")]
		_on_audio: CaptureCallback,
	) -> Result<Self> {
		Err(napi::Error::from_reason("Native audio capture is not supported on Android/Termux"))
	}

	#[napi]
	pub fn stop(&self) -> Result<()> {
		Ok(())
	}
}

/// Gapless mono `f32` playback through the default speaker.
#[napi]
pub struct AudioPlayback {
	#[cfg(not(target_os = "android"))]
	stream: Mutex<Option<PlaybackStream>>,
	#[cfg(not(target_os = "android"))]
	state:  Arc<PlaybackState>,
}

#[cfg(not(target_os = "android"))]
#[napi]
impl AudioPlayback {
	/// Open the default speaker at the requested logical sample rate.
	#[napi(constructor)]
	pub fn new(sample_rate: u32) -> Result<Self> {
		let stream = PlaybackStream::start(sample_rate).map_err(napi::Error::from_reason)?;
		let state = stream.state();
		Ok(Self { stream: Mutex::new(Some(stream)), state })
	}

	/// Queue mono floating-point PCM in playback order.
	#[napi]
	pub fn write(&self, samples: Float32Array) -> Result<()> {
		let stream = self.stream.lock();
		let stream = stream
			.as_ref()
			.ok_or_else(|| napi::Error::from_reason("Native audio playback is closed"))?;
		stream
			.writer()
			.and_then(|writer| writer.write(&samples))
			.map_err(napi::Error::from_reason)
	}

	/// Scale audio at render time so gain changes affect already queued samples.
	#[napi]
	pub fn set_gain(&self, gain: f64) -> Result<()> {
		let stream = self.stream.lock();
		let stream = stream
			.as_ref()
			.ok_or_else(|| napi::Error::from_reason("Native audio playback is closed"))?;
		stream
			.set_gain(gain as f32)
			.map_err(napi::Error::from_reason)
	}

	/// Close input, wait until queued samples reach the speaker, then release
	/// it.
	#[napi]
	pub async fn end(&self) -> Result<()> {
		{
			let mut stream = self.stream.lock();
			let Some(stream) = stream.as_mut() else {
				return Ok(());
			};
			stream.finish_input();
		}
		self.state.wait_for_drain().await;
		let stream = self.stream.lock().take();
		if let Some(mut stream) = stream {
			stream.stop().map_err(napi::Error::from_reason)?;
		}
		Ok(())
	}

	/// Stop immediately and discard all queued samples.
	#[napi]
	pub fn stop(&self) -> Result<()> {
		let stream = self.stream.lock().take();
		if let Some(mut stream) = stream {
			stream.stop().map_err(napi::Error::from_reason)?;
		}
		Ok(())
	}
}

#[cfg(target_os = "android")]
#[napi]
impl AudioPlayback {
	#[napi(constructor)]
	pub fn new(_sample_rate: u32) -> Result<Self> {
		Err(napi::Error::from_reason("Native audio playback is not supported on Android/Termux"))
	}

	#[napi]
	pub fn write(&self, _samples: Float32Array) -> Result<()> {
		Ok(())
	}

	#[napi]
	pub fn set_gain(&self, _gain: f64) -> Result<()> {
		Ok(())
	}

	#[napi]
	pub async fn end(&self) -> Result<()> {
		Ok(())
	}

	#[napi]
	pub fn stop(&self) -> Result<()> {
		Ok(())
	}
}

