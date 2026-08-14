/**
 * InfoHint —— 全局数值说明。
 *
 * 统一交互：每个数值旁放一个 ⓘ 按钮，点一下从底部弹出一张卡片，
 * 显示该数值的简短说明（含义 / 怎么算 / 正常范围）。所有页面共用同一套，
 * 不会各自发明不同的点击交互。
 *
 * 用法：
 *   <InfoHint hintKey="soc_voltage" />            // 独立按钮
 *   <MetricTile ... hintKey="battery_voltage" />  // 参数格自动带 ⓘ
 *   <InfoRow   ... hintKey="soh" />               // 信息行自动带 ⓘ
 *
 * 全局只需在根部挂一次 <InfoHintProvider>（见 (tabs)/_layout.tsx）。
 */
import React, { createContext, useCallback, useContext, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppText } from './AppText';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, radius, shadow, spacing } from '../theme';
import { HINTS, type HintKey } from '../valueHints';

type OpenFn = (key: HintKey) => void;
const Ctx = createContext<OpenFn>(() => {});
export const useInfoHint = (): OpenFn => useContext(Ctx);

export function InfoHintProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState<HintKey | null>(null);
  const open = useCallback<OpenFn>((k) => setKey(k), []);
  const close = useCallback(() => setKey(null), []);
  const hint = key ? HINTS[key] : null;

  return (
    <Ctx.Provider value={open}>
      {children}
      {/* ③ 按需挂载 Modal：key 为空时不渲染，避免在 7 个页面常驻一个透明 Modal */}
      {key != null && hint && (
        <Modal transparent animationType="fade" onRequestClose={close}>
          <Pressable style={styles.backdrop} onPress={close}>
            <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
              <View style={styles.handle} />
              <View style={styles.inner}>
                <View style={styles.head}>
                  <AppText style={styles.title}>{hint.title}</AppText>
                  <Pressable hitSlop={10} onPress={close} style={styles.closeBtn}>
                    <Ionicons name="close" size={18} color={colors.textMuted} />
                  </Pressable>
                </View>
                <AppText style={styles.body}>{hint.body}</AppText>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function InfoHint({
  hintKey,
  size = 14,
  color,
}: {
  hintKey: HintKey;
  size?: number;
  color?: string;
}) {
  // 全局数值说明 ⓘ 已按用户要求移除（提示标志过密、影响美观）。
  // 保留组件与 hintKey 契约不动，仅不再渲染标志；点击说明功能保留在
  // InfoHintProvider 中，后续若重新启用只需恢复此处返回即可。
  return null;
}

const styles = StyleSheet.create({
  iconBtn: { padding: 2 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    ...shadow.subtle,
    paddingBottom: 28,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderLight,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 14,
  },
  inner: { paddingHorizontal: spacing.lg },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    flex: 1,
    marginRight: spacing.sm,
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.text,
  },
  closeBtn: { padding: 4 },
  body: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 21,
  },
});
