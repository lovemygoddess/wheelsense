import React from 'react';
import { Animated, Pressable, StyleProp, Text, TextStyle, ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { enterStyle, useCountUp, useMountFade, usePressScale, usePulse } from '../hooks/useStagger';

/**
 * 数字滚动文本：值变化时从旧值平滑滚到新值（首次挂载从 0 滚上来）。
 * 封装成组件而不是直接用 hook，是为了避免调用方在条件渲染里踩 hook 顺序的坑。
 */
export function CountText({
  value,
  decimals = 0,
  style,
  fallback = '—',
  suffix = '',
  duration = 900,
}: {
  value: number | null | undefined;
  decimals?: number;
  style?: StyleProp<TextStyle>;
  fallback?: string;
  suffix?: string;
  duration?: number;
}) {
  const t = useCountUp(value, decimals, duration);
  return <AppText style={style}>{t == null ? fallback : `${t}${suffix}`}</AppText>;
}

/**
 * 呼吸脉冲容器：active 时子元素循环「淡+微缩」，用于在线/充电中/直连等实时状态。
 * 只包裹图标或小圆点，不要包裹参与 flex 布局的容器。
 */
export function Pulse({
  active,
  children,
  style,
  minOpacity = 0.45,
  scaleTo = 1.15,
  duration = 1100,
}: {
  active?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  minOpacity?: number;
  scaleTo?: number;
  duration?: number;
}) {
  const a = usePulse(!!active, duration);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: a.interpolate({ inputRange: [0, 1], outputRange: [1, minOpacity] }),
          transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [1, scaleTo] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * 按压回弹按钮：外层 Animated.View 负责缩放，内层保持原 Pressable 的布局样式。
 * flex 场景请通过 wrapStyle 把 flex 提到外层，避免布局塌陷。
 */
export function PressScale({
  children,
  style,
  wrapStyle,
  min = 0.95,
  ...rest
}: React.ComponentProps<typeof Pressable> & {
  wrapStyle?: StyleProp<ViewStyle>;
  min?: number;
}) {
  const p = usePressScale(min);
  return (
    <Animated.View style={[wrapStyle, p.pressStyle]}>
      <Pressable style={style} onPressIn={p.onPressIn} onPressOut={p.onPressOut} {...rest}>
        {children}
      </Pressable>
    </Animated.View>
  );
}

/**
 * 网格/列表单元逐个入场：按 index 推导延迟，最多累计 8 格避免长列表末尾等太久。
 * 直接替换原来的容器 View 使用（style 透传，不改布局）。
 */
export function FadeIn({
  index = 0,
  step = 55,
  style,
  children,
}: {
  index?: number;
  step?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  // 只给首屏若干个排队延迟；往后滚动进来的单元立即淡入，避免「滚下去要等」的迟滞感
  const a = useMountFade(index < 8 ? index * step : 0);
  return <Animated.View style={[style, enterStyle(a)]}>{children}</Animated.View>;
}
