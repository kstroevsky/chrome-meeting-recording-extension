import { PopupController } from './popup/PopupController';

const controller = new PopupController({
  saveBtn: document.getElementById('save') as HTMLButtonElement | null,
  micBtn: document.getElementById('enable-mic') as HTMLButtonElement | null,
  startBtn: document.getElementById('start-rec') as HTMLButtonElement | null,
  stopBtn: document.getElementById('stop-rec') as HTMLButtonElement | null,
});

controller.init();
