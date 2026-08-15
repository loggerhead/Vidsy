import { extractYouTubeMedia } from './player-formats';
import assert from 'node:assert/strict';
import test from 'node:test';

test('keeps MP4 and WebM 720p60 formats and pairs each with compatible audio', () => {
  const media = extractYouTubeMedia({
    videoDetails: { title: 'Example' },
    streamingData: {
      formats: [
        {
          url: 'https://media.example/progressive-720.mp4',
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
          width: 1280,
          height: 720,
          fps: 30,
          bitrate: 2_000_000,
          qualityLabel: '720p',
        },
      ],
      adaptiveFormats: [
        {
          url: 'https://media.example/video-720p60.mp4',
          mimeType: 'video/mp4; codecs="avc1.4d4020"',
          width: 1280,
          height: 720,
          fps: 60,
          bitrate: 3_500_000,
          qualityLabel: '720p60',
        },
        {
          url: 'https://media.example/video-720p60.webm',
          mimeType: 'video/webm; codecs="vp9"',
          width: 1280,
          height: 720,
          fps: 60,
          bitrate: 3_000_000,
          qualityLabel: '720p60',
        },
        {
          url: 'https://media.example/audio-opus.webm',
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 160_000,
        },
        {
          url: 'https://media.example/audio-aac.m4a',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 192_000,
        },
      ],
    },
  });

  assert.deepEqual(
    media?.variants.map(variant => ({
      url: variant.url,
      frameRate: variant.frameRate,
      audioUrl: variant.audioUrl,
    })),
    [
      {
        url: 'https://media.example/video-720p60.mp4',
        frameRate: 60,
        audioUrl: 'https://media.example/audio-aac.m4a',
      },
      {
        url: 'https://media.example/video-720p60.webm',
        frameRate: 60,
        audioUrl: 'https://media.example/audio-opus.webm',
      },
      {
        url: 'https://media.example/progressive-720.mp4',
        frameRate: 30,
        audioUrl: undefined,
      },
    ],
  );
});
