const { contextBridge, webUtils, ipcRenderer } = require('electron');

// Bridges two things pure web content can never do on its own:
// 1. Recovering a dropped File object's real absolute path (browsers never
//    expose this; Electron's webUtils API can because it controls the
//    renderer <-> OS boundary itself).
// 2. Asking the OS to open a path with its default application.
contextBridge.exposeInMainWorld('electronAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  // 3. Showing a native Windows toast (reminder preview).
  testNotify: (title) => ipcRenderer.invoke('test-notify', title),
  // data changed outside the page (pulled from Google Calendar)
  onDataChanged: (cb) => ipcRenderer.on('data-changed', () => cb()),
  setTitleBarTheme: (dark) => ipcRenderer.send('titlebar-theme', !!dark),
  // 4. Google account link (OAuth runs in the main process; tokens never reach the page).
  google: {
    status: () => ipcRenderer.invoke('google-status'),
    connect: () => ipcRenderer.invoke('google-connect'),
    disconnect: () => ipcRenderer.invoke('google-disconnect'),
    testMail: () => ipcRenderer.invoke('google-test-mail'),
    testReminderMail: (projectId) => ipcRenderer.invoke('google-test-reminder-mail', projectId),
    calendarSync: () => ipcRenderer.invoke('calendar-sync'),
    driveList: (opts) => ipcRenderer.invoke('drive-list', opts),
  },
});
