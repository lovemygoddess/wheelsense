import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

/** 卡片错峰入场样式：opacity + 轻微上移。与仪表板首页一致的观感。 */
export const enterStyle = (a: Animated.Value): any => ({
  opacity: a,
  transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
});

/**
 * 入场错峰动画：返回 count 个 Animated.Value，挂载后依次淡入上移一次。
 * 用 once 守卫，避免 30s/60s 轮询重渲染时反复重播。
 */
export function useStagger(count: number, step = 70, duration = 380) {
  const reduced = useReducedMotion();
  const anims = useRef(Array.from({ length: count }, () => new Animated.Value(0))).current;
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (reduced) {
      anims.forEach(a => a.setValue(1));
      return;
    }
    Animated.stagger(
      step,
      anims.map((a) =>
        Animated.timing(a, { toValue: 1, duration, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
      ),
    ).start();
  }, [anims, step, duration, reduced]);
  return anims;
}

/**
 * 按压回弹：给 Pressable 的 onPressIn/onPressOut 加轻微缩放，提升触感反馈。
 * 把 pressStyle 摊到外层 Animated.View 上（不改变内部布局）。
 */
export function usePressScale(min = 0.96) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) => reduced
    ? scale.setValue(v)
    : Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  return {
    scale,
    pressStyle: { transform: [{ scale }] } as any,
    onPressIn: () => to(min),
    onPressOut: () => to(1),
  };
}

/**
 * 展开/收起过渡：open 变化时把 0↔1 平滑过渡。
 * 用于折叠区内容淡入下滑 + 箭头旋转。
 */
export function useReveal(open: boolean, duration = 240) {
  const reduced = useReducedMotion();
  const a = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      a.setValue(open ? 1 : 0);
      return;
    }
    Animated.timing(a, {
      toValue: open ? 1 : 0,
      duration,
      useNativeDriver: true,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    }).start();
  }, [open, a, duration, reduced]);
  return a;
}

/** 折叠内容的进入样式（淡入 + 轻微下滑） */
export const revealStyle = (a: Animated.Value): any => ({
  opacity: a,
  transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }],
});

/** 箭头旋转样式：收起 0deg，展开 180deg */
export const spinStyle = (a: Animated.Value, deg = 180): any => ({
  transform: [{ rotate: a.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${deg}deg`] }) }],
});

/**
 * 呼吸脉冲：active 时循环 0→1→0，用于「在线 / 充电中 / 直连」等实时状态点。
 * active=false 时停在 0，避免后台白耗。
 */
export function usePulse(active: boolean, duration = 1100) {
  const reduced = useReducedMotion();
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || reduced) {
      a.stopAnimation(() => a.setValue(0));
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
        Animated.timing(a, { toValue: 0, duration, useNativeDriver: true, easing: Easing.in(Easing.ease) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, a, duration, reduced]);
  return a;
}

/**
 * 数字滚动：值变化时从旧值平滑过渡到新值。
 * 返回已按 decimals 位数格式化好的字符串，直接塞进 <Text>。
 * 首次挂载从 0 滚上来，制造「仪表上电」的感觉。
 *
 * 两处降耗（BMS/仪表 1s 轮询下很关键）：
 *  1. 监听回调先格式化再比对，字符串没变就不 setState，React 直接跳过重渲染；
 *  2. 小幅波动（<5% 且 <1）直接落位，不重放动画，避免每秒都触发一轮逐帧刷新。
 */
export function useCountUp(value: number | null | undefined, decimals = 0, duration = 900) {
  const reduced = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;
  const [display, setDisplay] = useState('0');
  const lastRef = useRef<number | null>(null);
  const target = typeof value === 'number' && isFinite(value) ? value : 0;

  useEffect(() => {
    const id = anim.addListener(({ value: v }) => {
      const text = v.toFixed(decimals);
      setDisplay((prev) => (prev === text ? prev : text));
    });
    return () => anim.removeListener(id);
  }, [anim, decimals]);

  useEffect(() => {
    const prev = lastRef.current;
    lastRef.current = target;
    if (reduced) {
      anim.setValue(target);
      setDisplay(target.toFixed(decimals));
      return;
    }
    const threshold = Math.max(1, Math.abs(prev ?? 0) * 0.05);
    if (prev !== null && Math.abs(target - prev) <= threshold) {
      anim.setValue(target);
      return;
    }
    const t = Animated.timing(anim, {
      toValue: target,
      duration,
      useNativeDriver: false,
      easing: Easing.out(Easing.cubic),
    });
    t.start();
    return () => t.stop();
  }, [target, anim, duration, reduced, decimals]);

  if (value == null || !isFinite(target)) return null;
  return display;
}

/** 单元素挂载淡入（列表行逐条入场用），delay 由 index 推导。 */
export function useMountFade(delay = 0, duration = 260) {
  const reduced = useReducedMotion();
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      a.setValue(1);
      return;
    }
    const t = Animated.timing(a, {
      toValue: 1,
      duration,
      delay,
      useNativeDriver: true,
      easing: Easing.out(Easing.ease),
    });
    t.start();
    return () => t.stop();
  }, [a, delay, duration, reduced]);
  return a;
}
