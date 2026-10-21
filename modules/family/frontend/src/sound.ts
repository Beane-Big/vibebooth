// 加减分音效：用 Web Audio 现场合成，不需要音频文件。
// 加分是清脆的“叮叮”（高音正弦带泛音，像小铃铛）；扣分是低沉的“嘟”（低音方波加低通，音高下滑）。

type Kind = "plus" | "minus";

let audioCtx: AudioContext | null = null;
let pending: { kind: Kind; quiet: boolean; n: number; t: number } | null = null;
let blocked = false;
let onBlockedChange: (blocked: boolean) => void = () => {};

// 长按加分时，叮声沿五声音阶一级级升高。
const DING = [784, 880, 988, 1175, 1319, 1568];

/** 浏览器没放行声音时通知界面，在声音按钮上提示再点一下。 */
export function watchBlocked(cb: (blocked: boolean) => void) {
  onBlockedChange = cb;
}

function setBlocked(b: boolean) {
  blocked = b;
  onBlockedChange(blocked);
}

function ensureAudio(): AudioContext | null {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    audioCtx = new AC();
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
    } catch {
      // 部分系统没有这个接口
    }
  }
  return audioCtx;
}

// 一个音符：type 波形，f0 滑到 f1 的音高，start 延后几秒开始，dur 时长，vol 音量，lp 低通滤波（可选，让声音更闷）。
function note(c: AudioContext, type: OscillatorType, f0: number, f1: number, start: number, dur: number, vol: number, lp?: number) {
  const t = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  if (lp) {
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = lp;
    g.connect(f);
    f.connect(c.destination);
  } else {
    g.connect(c.destination);
  }
  o.start(t);
  o.stop(t + dur + 0.03);
}

/** quiet 是长按连续触发时的短促版本，n 是连续第几次。 */
export function playSound(kind: Kind, quiet = false, n = 0) {
  try {
    const c = ensureAudio();
    if (!c) return;
    const go = () => {
      setBlocked(false);
      try {
        if (kind === "plus") {
          if (quiet) {
            const f = DING[Math.min(n, DING.length - 1)];
            note(c, "sine", f, f, 0, 0.14, 0.3);
          } else {
            note(c, "sine", 1047, 1047, 0, 0.4, 0.4);
            note(c, "sine", 2093, 2093, 0, 0.25, 0.1);
            note(c, "sine", 1568, 1568, 0.09, 0.55, 0.36);
            note(c, "sine", 3136, 3136, 0.09, 0.3, 0.09);
          }
        } else if (quiet) {
          note(c, "sawtooth", 150, 110, 0, 0.1, 0.22, 500);
        } else {
          note(c, "square", 196, 98, 0, 0.34, 0.28, 700);
        }
      } catch {
        // 忽略
      }
    };
    if (c.state === "running") {
      go();
      return;
    }
    // 浏览器还没放行声音（iPad 刷新后第一次按、或从后台切回来时常见）：
    // 先记下这次的声音，等声音通道一打开就补播；一直打不开就在按钮上提示。
    const tok = (pending = { kind, quiet, n, t: Date.now() });
    c.resume().then(
      () => {
        if (c.state !== "running") setBlocked(true);
        else if (pending === tok) {
          pending = null;
          go();
        }
      },
      () => setBlocked(true),
    );
  } catch {
    // 浏览器不支持音频时忽略
  }
}

// 第一次碰页面（点、触摸、按键）就先把声音通道打开，并播一个无声的小片段，iPad / 手机的浏览器也需要这一步。
function unlock() {
  try {
    const c = ensureAudio();
    if (!c || c.state === "running") return;
    const rp = c.resume();
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, 22050);
    s.connect(c.destination);
    s.start(0);
    rp.then(() => {
      // 刚才被拦住的声音如果还没过期（2 秒内），现在补播。
      if (c.state === "running" && pending && Date.now() - pending.t < 2000) {
        const q = pending;
        pending = null;
        playSound(q.kind, q.quiet, q.n);
      }
    });
  } catch {
    // 忽略
  }
}

for (const ev of ["pointerdown", "touchend", "click", "keydown"]) {
  document.addEventListener(ev, unlock, { capture: true, passive: true });
}
