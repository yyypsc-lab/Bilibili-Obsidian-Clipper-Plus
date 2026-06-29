(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.BOCTranscriptionNormalize = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeTranscriptionSegments(raw, videoDuration) {
    const duration = normalizeDuration(videoDuration);
    const source = raw && typeof raw === "object" ? raw : {};
    let rawSegments = Array.isArray(source.segments) ? source.segments : [];

    if (!rawSegments.length && typeof source.text === "string" && source.text.trim()) {
      rawSegments = [{ start: 0, end: duration || 3, text: source.text }];
    }

    const mapped = rawSegments
      .map((item, index) => normalizeOneSegment(item, index, rawSegments, duration))
      .filter((item) => item && item.content);

    const normalized = mapped.map((item, index) => {
      const next = mapped[index + 1];
      let to = item.to;
      if (!(to > item.from)) {
        if (next && next.from > item.from) {
          to = next.from;
        } else if (duration > item.from) {
          to = Math.min(duration, item.from + 3);
        } else {
          to = item.from + 3;
        }
      }
      return {
        from: roundSeconds(item.from),
        to: roundSeconds(to),
        content: item.content
      };
    });

    validateSegmentsAgainstDuration(normalized, duration);
    return normalized;
  }

  function normalizeOneSegment(item, index, allItems, duration) {
    const value = item && typeof item === "object" ? item : {};
    const from = normalizeSeconds(value.from ?? value.start ?? value.begin ?? value.start_time, 0);
    let to = normalizeSeconds(value.to ?? value.end ?? value.finish ?? value.end_time, 0);
    if (!(to > from)) {
      const next = allItems[index + 1] || null;
      to = normalizeSeconds(next?.from ?? next?.start ?? next?.begin ?? next?.start_time, 0);
    }
    const content = String(value.content ?? value.text ?? value.sentence ?? "").replace(/\s+/g, " ").trim();
    if (!content) {
      return null;
    }
    return {
      from: Math.max(0, from),
      to: to > 0 ? to : duration || 0,
      content
    };
  }

  function normalizeSeconds(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return fallback;
    }
    return num > 60 * 60 * 24 ? num / 1000 : num;
  }

  function normalizeDuration(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 0;
  }

  function roundSeconds(value) {
    return Math.round((Number(value) || 0) * 1000) / 1000;
  }

  function validateSegmentsAgainstDuration(items, duration) {
    if (!(duration > 0) || !Array.isArray(items) || !items.length) {
      return;
    }
    const maxTo = items.reduce((max, item) => Math.max(max, Number(item.to || 0), Number(item.from || 0)), 0);
    const tolerance = Math.max(12, duration * 0.15);
    if (maxTo > duration + tolerance) {
      throw new Error(`Transcription exceeds video duration: max=${maxTo}, duration=${duration}`);
    }
  }

  return {
    normalizeTranscriptionSegments
  };
});