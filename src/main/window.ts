import { BrowserWindow } from 'electron'

export function createWindow() {
  return new BrowserWindow({
    width: 1200,
    height: 800,
  })
}
