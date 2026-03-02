#!/usr/bin/env node
/**
 * Convert SVG icons to PNG (required by VS Code extension marketplace).
 * Run: node scripts/convert-icons.js
 * Requires: npm install sharp --save-dev
 */
const fs = require('fs');
const path = require('path');

async function convert() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.error('Run: npm install sharp --save-dev');
    process.exit(1);
  }

  const resDir = path.join(__dirname, '..', 'resources');
  const pairs = [
    ['icon.svg', 'icon.png'],
    ['activity-icon.svg', 'activity-icon.png'],
  ];

  for (const [svg, png] of pairs) {
    const svgPath = path.join(resDir, svg);
    const pngPath = path.join(resDir, png);
    if (!fs.existsSync(svgPath)) {
      console.warn('Skip:', svg, '(not found)');
      continue;
    }
    await sharp(svgPath)
      .png()
      .resize(128, 128)
      .toFile(pngPath);
    console.log('Created:', png);
  }
}

convert().catch((e) => {
  console.error(e);
  process.exit(1);
});
