/**
 * ErrorBoundary — 捕获子树渲染/Hook 抛错，显示降级 UI 而非白屏。
 *
 * 用途：仪表盘在「后台超时 → Activity 被系统回收 → 切回 recreate」时，
 * 任何渲染异常原本会让生产构建直接白屏（无红屏）。这里兜住，给出可读的
 * 错误提示 + 重试按钮，用户点一下即可重建子树，不必杀进程重进。
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { AppText } from './AppText';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, radius, spacing } from '../theme';

interface Props {
  children: React.ReactNode;
  /** 出错时显示的标题，便于区分是哪个页面崩了。 */
  label?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 仅本地日志，不抛红屏；生产构建下这是白屏的唯一防线。
    console.error('[ErrorBoundary]', this.props.label ?? 'page', error, info?.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <View style={styles.wrap}>
          <Ionicons name="alert-circle-outline" size={34} color={colors.danger} />
          <AppText style={styles.title}>{this.props.label ?? '页面'}渲染出错</AppText>
          <AppText style={styles.msg} numberOfLines={4} ellipsizeMode="tail">
            {this.state.error.message || String(this.state.error)}
          </AppText>
          <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]} onPress={this.retry}>
            <Ionicons name="refresh-outline" size={15} color={colors.card} style={{ marginRight: 6 }} />
            <AppText style={styles.btnText}>重试</AppText>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text, marginTop: spacing.xs },
  msg: {
    fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center',
    fontFamily: undefined, maxWidth: 320,
  },
  btn: {
    marginTop: spacing.md,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.primary, borderRadius: radius.lg,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
  },
  btnText: { color: colors.card, fontSize: fontSize.sm, fontWeight: '700' },
});
