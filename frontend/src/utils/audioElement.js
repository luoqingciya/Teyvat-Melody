// audioElement：全局唯一的 HTML5 Audio 实例，供 playerStore 所有操作共享。
let element = null;

export function getAudio() {
  if (!element) {
    element = new Audio();
    element.preload = "auto";
  }
  return element;
}

export default getAudio;