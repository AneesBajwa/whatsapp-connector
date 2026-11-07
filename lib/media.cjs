'use strict';
/** Media type, extension and original file name of a message. */

const { unwrap, toUnix } = require('./message-store.cjs');

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

function mediaInfo(message) {
  const m = unwrap(message);
  const media = m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage || m.stickerMessage || {};
  const mimetype = media.mimetype || 'application/octet-stream';
  let ext = MIME_EXT[mimetype];
  if (!ext) {
    const parts = mimetype.split(';')[0].split('/');
    ext = parts.length === 2 && parts[1] ? parts[1] : 'bin';
  }
  // fileLength may be a number, a Long, or a serialized Long.
  return { mimetype, ext, fileName: media.fileName || null, fileLength: toUnix(media.fileLength) };
}

module.exports = { mediaInfo };
