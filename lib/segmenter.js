(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Segmenter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Finds natural pauses in a live recording so hands-free mode can paste sentence by sentence while you keep talking.
  // Feed it consecutive Float32 audio chunks (-1..1); it returns { cut, paragraph } when a sentence just ended.
  class Segmenter {
    constructor(o = {}) {
      this.sampleRate = o.sampleRate || 16000;
      this.threshold = o.threshold ?? 0.015;      // RMS above this counts as speech
      this.silenceMs = o.silenceMs ?? 1100;       // a pause this long ends a sentence
      this.minSpeechMs = o.minSpeechMs ?? 500;    // ignore coughs / blips shorter than this
      this.paragraphMs = o.paragraphMs ?? 2600;   // a pause this long means "new paragraph"
      this.reset();
    }
    reset() { this.speechMs = 0; this.silenceRun = 0; this.sinceSpeech = 0; this.cuts = 0; this.paragraph = false; }

    feed(chunk) {
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / (chunk.length || 1));
      const ms = (chunk.length / this.sampleRate) * 1000;
      if (rms >= this.threshold) {
        if (this.speechMs === 0 && this.cuts > 0 && this.sinceSpeech >= this.paragraphMs) this.paragraph = true;
        this.speechMs += ms; this.silenceRun = 0; this.sinceSpeech = 0;
        return null;
      }
      this.silenceRun += ms; this.sinceSpeech += ms;
      if (this.speechMs >= this.minSpeechMs && this.silenceRun >= this.silenceMs) {
        const out = { cut: true, paragraph: this.paragraph };
        this.cuts++; this.speechMs = 0; this.paragraph = false; this.silenceRun = 0; // sinceSpeech keeps counting through the gap
        return out;
      }
      if (this.silenceRun >= this.silenceMs && this.speechMs > 0) this.speechMs = 0;  // it was only a blip: forget it
      return null;
    }

    // Call when recording stops: is there real speech left over that has not been sent yet?
    finish() { return { hasSpeech: this.speechMs >= 200, paragraph: this.paragraph }; }
  }
  return Segmenter;
});
