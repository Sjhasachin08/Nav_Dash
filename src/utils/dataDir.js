const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_DIR = path.resolve(process.env.APP_DATA_DIR || DEFAULT_DATA_DIR);

function getDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

function getDataPath(filename) {
  const destination = path.join(getDataDir(), filename);
  const bundledFile = path.join(DEFAULT_DATA_DIR, filename);

  if (filename === 'navdata.json' && destination !== bundledFile && !fs.existsSync(destination)) {
    fs.copyFileSync(bundledFile, destination);
  }

  return destination;
}

module.exports = { getDataDir, getDataPath };