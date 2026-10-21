import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { api, type Member } from "../api";
import { resizePhoto } from "../photo";
import { playSound, watchBlocked } from "../sound";
import s from "./Board.module.css";

const SORT_DELAY = 2500; // 最后一次加减分后，等这么多毫秒再按分数重新排序
const FLUSH_DELAY = 300; // 长按连续加减分时，每隔这么久把累计的分数提交一次
const POLL_INTERVAL = 10000; // 定时刷新，看到其他设备上打的分
const HOLD_DELAY = 420; // 按住这么久后开始连加连扣
const HUES = [205, 330, 40, 150, 265, 15];
const SOUND_KEY = "family-sound"; // 声音开关只跟着这台设备走，存在浏览器里

type Float = { key: number; personId: number; up: boolean; dx: number };

// 每个人固定一个颜色，排序时跟着人走。
function hueOf(personId: number) {
  return HUES[Math.abs(personId - 1) % HUES.length];
}

function readSound() {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

function byScore(a: Member, b: Member) {
  return b.score - a.score || a.personId - b.personId;
}

export default function Board() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [peopleAvailable, setPeopleAvailable] = useState(true);
  const [error, setError] = useState("");
  const [sound, setSound] = useState(readSound);
  const [blocked, setBlocked] = useState(false);
  const [floats, setFloats] = useState<Float[]>([]);

  const cards = useRef(new Map<number, HTMLElement>());
  const scoreEls = useRef(new Map<number, HTMLElement>());
  const fileInput = useRef<HTMLInputElement>(null);
  const photoFor = useRef<number | null>(null); // 正在给谁换照片
  // 还没提交的加减分，以及正在提交中的请求数；有这两样时不用服务器的分数覆盖本地显示。
  const pending = useRef(new Map<number, number>());
  const inflight = useRef(new Map<number, number>());
  const flushTimer = useRef<number | undefined>(undefined);
  const sortTimer = useRef<number | undefined>(undefined);
  const flipFrom = useRef<Map<number, DOMRect> | null>(null);
  const floatKey = useRef(0);
  const soundOn = useRef(sound);
  soundOn.current = sound;

  const busy = (id: number) => pending.current.has(id) || (inflight.current.get(id) ?? 0) > 0;

  // 拉取最新分数和人员：保留当前顺序，只更新内容；新加的人排在后面，删掉的人移除，再按需重新排序。
  const load = useCallback(async () => {
    try {
      const view = await api.board();
      setPeopleAvailable(view.peopleAvailable);
      setError("");
      setMembers((current) => {
        if (!current) return view.members;
        const fresh = new Map(view.members.map((m) => [m.personId, m]));
        const kept = current
          .filter((m) => fresh.has(m.personId))
          .map((m) => {
            const f = fresh.get(m.personId)!;
            return busy(m.personId) ? { ...f, score: m.score } : f;
          });
        const keptIds = new Set(kept.map((m) => m.personId));
        return [...kept, ...view.members.filter((m) => !keptIds.has(m.personId))];
      });
      scheduleSort();
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    watchBlocked(setBlocked);
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && pending.current.size === 0) load();
    }, POLL_INTERVAL);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // 防抖排序：每次加减分都会重新计时，停手 SORT_DELAY 毫秒后才按分数从高到低排列。
  function scheduleSort() {
    clearTimeout(sortTimer.current);
    sortTimer.current = window.setTimeout(sortNow, SORT_DELAY);
  }

  function sortNow() {
    setMembers((current) => {
      if (!current) return current;
      const sorted = [...current].sort(byScore);
      if (sorted.every((m, i) => m.personId === current[i].personId)) return current;
      // 记下排序前各卡片的位置，渲染后从旧位置滑到新位置。
      flipFrom.current = new Map([...cards.current].map(([id, el]) => [id, el.getBoundingClientRect()]));
      return sorted;
    });
  }

  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    if (!from || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [id, el] of cards.current) {
      const a = from.get(id);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      el.style.zIndex = "2";
      const anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 500,
        easing: "cubic-bezier(.2,.8,.2,1)",
      });
      anim.onfinish = () => (el.style.zIndex = "");
    }
  }, [members]);

  function flush() {
    flushTimer.current = undefined;
    const batch = [...pending.current];
    pending.current.clear();
    for (const [id, delta] of batch) {
      if (delta === 0) continue;
      inflight.current.set(id, (inflight.current.get(id) ?? 0) + 1);
      api
        .change(id, delta)
        .then((res) => {
          inflight.current.set(id, inflight.current.get(id)! - 1);
          // 期间没有新的加减分，就以服务器的分数为准（其他设备同时打的分也会算进来）。
          if (!busy(id)) {
            setMembers((ms) => ms && ms.map((m) => (m.personId === id ? { ...m, score: res.score } : m)));
          }
        })
        .catch((err) => {
          inflight.current.set(id, inflight.current.get(id)! - 1);
          setError(err instanceof Error ? err.message : "保存失败");
          load(); // 本地显示的分数可能不对了，重新拉一次
        });
    }
  }

  function change(personId: number, d: number, quiet: boolean, n: number) {
    setMembers((ms) => ms && ms.map((m) => (m.personId === personId ? { ...m, score: m.score + d } : m)));

    const el = scoreEls.current.get(personId);
    if (el) {
      el.classList.remove(s.pop);
      void el.offsetWidth; // 强制重排，让动画能重新播放
      el.classList.add(s.pop);
    }
    const key = ++floatKey.current;
    setFloats((fs) => [...fs, { key, personId, up: d > 0, dx: -50 + (Math.random() * 40 - 20) }]);
    if (soundOn.current) playSound(d > 0 ? "plus" : "minus", quiet, n);

    pending.current.set(personId, (pending.current.get(personId) ?? 0) + d);
    if (flushTimer.current === undefined) flushTimer.current = window.setTimeout(flush, FLUSH_DELAY);
    scheduleSort();
  }

  function pickPhoto(personId: number) {
    photoFor.current = personId;
    fileInput.current?.click();
  }

  async function changePhoto(file: File | undefined) {
    const personId = photoFor.current;
    photoFor.current = null;
    if (!file || personId === null) return;
    try {
      const res = await api.setPhoto(personId, await resizePhoto(file));
      setMembers((ms) => ms && ms.map((m) => (m.personId === personId ? { ...m, photo: res.photo } : m)));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "换照片失败");
    }
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      // 存储不可用时忽略
    }
    if (next) playSound("plus");
  }

  const count = members?.length ?? 0;
  const top = Math.max(...(members ?? []).map((m) => m.score));
  const colsP = Math.min(2, Math.max(count, 1));
  const colsL = Math.min(3, Math.max(count, 1));
  const gridStyle = {
    "--cols-p": colsP,
    "--rows-p": Math.max(1, Math.ceil(count / colsP)),
    "--cols-l": colsL,
    "--rows-l": Math.max(1, Math.ceil(count / colsL)),
  } as CSSProperties;

  return (
    <div className={s.board}>
      {members && count === 0 && (
        <div className={s.empty}>
          {peopleAvailable ? (
            <p>
              还没有人员，先去 <a href="/apps/people/">人员管理</a> 里添加。
            </p>
          ) : (
            <p>人员管理暂时不可用，请稍后再试。</p>
          )}
        </div>
      )}
      {count > 0 && (
        <main className={s.grid} style={gridStyle}>
          {members!.map((m) => (
            <section
              key={m.personId}
              className={s.card}
              style={{ "--h": hueOf(m.personId) } as CSSProperties}
              ref={(el) => {
                if (el) cards.current.set(m.personId, el);
                else cards.current.delete(m.personId);
              }}
            >
              {top > 0 && m.score === top && <span className={s.crown}>榜首</span>}
              <div className={s.in}>
                <div className={s.avatarWrap}>
                  <button className={s.avatar} type="button" aria-label="更换照片" onClick={() => pickPhoto(m.personId)} disabled={!peopleAvailable}>
                    {m.photo ? <img src={m.photo} alt={`${m.name}的照片`} /> : <Face hue={hueOf(m.personId)} />}
                  </button>
                  <span className={s.badge}>
                    <CameraIcon />
                  </span>
                </div>
                <div className={s.info}>
                  <div className={s.name}>{m.name || `#${m.personId}`}</div>
                  <div
                    className={s.score}
                    aria-live="polite"
                    ref={(el) => {
                      if (el) scoreEls.current.set(m.personId, el);
                      else scoreEls.current.delete(m.personId);
                    }}
                  >
                    {m.score}
                  </div>
                  <div className={s.btns}>
                    <HoldButton className={`${s.btn} ${s.plus}`} label="加一分" text="+" onStep={(q, n) => change(m.personId, 1, q, n)} />
                    <HoldButton className={`${s.btn} ${s.minus}`} label="扣一分" text="−" onStep={(q, n) => change(m.personId, -1, q, n)} />
                  </div>
                </div>
              </div>
              {floats
                .filter((f) => f.personId === m.personId)
                .map((f) => (
                  <span
                    key={f.key}
                    className={`${s.float} ${f.up ? s.up : s.down}`}
                    style={{ "--dx": `${f.dx}%` } as CSSProperties}
                    onAnimationEnd={() => setFloats((fs) => fs.filter((x) => x.key !== f.key))}
                  >
                    {f.up ? "★ +1" : "−1"}
                  </span>
                ))}
            </section>
          ))}
        </main>
      )}
      <div className={s.bar}>
        <a className={s.tool} href="/">
          ← 门户
        </a>
        <a className={s.tool} href="/apps/people/">
          管理人员
        </a>
        <span className={s.spacer} />
        {error && <span className={s.warn}>{error}</span>}
        {!peopleAvailable && count > 0 && <span className={s.warn}>人员管理暂时不可用，只显示分数</span>}
        <button className={s.tool} type="button" onClick={toggleSound}>
          {!sound ? "声音：关" : blocked ? "声音：开（浏览器没放行，再点一下）" : "声音：开"}
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          changePhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// 长按连加/连扣：按下立刻加减一次，按住 HOLD_DELAY 毫秒后开始连续加减，并且越按越快；松手、移出按钮或被系统打断就停。
function HoldButton({ className, label, text, onStep }: { className: string; label: string; text: string; onStep: (quiet: boolean, n: number) => void }) {
  const delay = useRef<number | undefined>(undefined);
  const tick = useRef<number | undefined>(undefined);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  const stop = useCallback(() => {
    clearTimeout(delay.current);
    clearTimeout(tick.current);
  }, []);

  useEffect(() => {
    document.addEventListener("visibilitychange", stop);
    return () => {
      document.removeEventListener("visibilitychange", stop);
      stop();
    };
  }, [stop]);

  function step(wait: number, n: number) {
    stepRef.current(true, n);
    tick.current = window.setTimeout(() => step(Math.max(60, wait * 0.92), n + 1), wait);
  }

  function start(e: PointerEvent) {
    if (e.button > 0) return;
    stop();
    stepRef.current(false, 0);
    delay.current = window.setTimeout(() => step(150, 1), HOLD_DELAY);
  }

  return (
    <button
      className={className}
      type="button"
      aria-label={label}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onBlur={stop}
      onContextMenu={(e) => e.preventDefault()}
      // 键盘（回车/空格）触发的点击 detail 为 0；鼠标和触摸已在 pointerdown 处理，避免重复计分。
      onClick={(e) => e.detail === 0 && stepRef.current(false, 0)}
    >
      {text}
    </button>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h4l2-3h6l2 3h4v11H3z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

// 没有照片时显示的默认笑脸，颜色跟着这个人的固定色。
function Face({ hue }: { hue: number }) {
  const skin = `hsl(${hue} 70% 78%)`;
  const cheek = `hsl(${(hue + 330) % 360} 85% 72%)`;
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" fill={`hsl(${hue} 75% 70%)`} />
      <circle cx="50" cy="54" r="30" fill={skin} />
      <circle cx="40" cy="50" r="4" fill="#23305a" />
      <circle cx="60" cy="50" r="4" fill="#23305a" />
      <circle cx="34" cy="60" r="5" fill={cheek} opacity="0.8" />
      <circle cx="66" cy="60" r="5" fill={cheek} opacity="0.8" />
      <path d="M41 62 Q50 72 59 62" stroke="#23305a" strokeWidth="3.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}
