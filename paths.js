// Single place that decides where user data (projects, attachments, Google
// tokens, backups) lives.
//  - Running from source (npm start / start.bat): ./data  (unchanged)
//  - Installed .exe: %APPDATA%\<app name>\data  (the install folder is read-only)
const path = require('path');

let dataDir = path.join(__dirname, 'data');
try {
  const { app } = require('electron');
  if (app && typeof app.getPath === 'function' && app.isPackaged) {
    dataDir = path.join(app.getPath('userData'), 'data');
  }
} catch { /* plain node, no electron */ }

module.exports = { DATA_DIR: dataDir };
