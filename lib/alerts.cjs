'use strict';
/**
 * Alerts for the owner, delivered the same way as requests: a markdown file
 * in requests/ (Kind: alert), so the hook that wakes Muse for requests also
 * wakes it for these. Muse tells the owner in the Muse app; nothing is sent
 * in WhatsApp.
 */

const path = require('path');

const { writeOnce, stamp, slug } = require('./request-files.cjs');

function writeAlert({ root, config, key, title, lines }) {
  const name = `${stamp(Math.floor(Date.now() / 1000))}-alert-${slug(key)}.md`;
  const body = [
    `# Muse alert: ${title}`,
    '',
    'Status: pending',
    'Kind: alert',
    `Needs approval: no. Tell ${config.ownerName} in the Muse app.`,
    '',
    ...lines,
    '',
  ].join('\n');
  writeOnce(path.join(root, 'requests'), name, body);
  return name;
}

module.exports = { writeAlert };
