import React from 'react';
import { Text, View } from 'react-native';
import { AppText } from './AppText';
import { colors, fontMono, fontSize } from '../theme';
import { InfoHint } from './InfoHint';
import { type HintKey } from '../valueHints';

/**
 * 统一的「标签 : 值」行 —— 所有 tab 的字段列表共用，保证值列右对齐、整齐。
 * - labelWidth：左侧标签固定列宽，值从该 x 起右对齐到行尾，形成整齐的值列。
 * - highlight / accent：高亮（加粗）或自定义值颜色。
 * - hintKey：标签右侧自动渲染一个 ⓘ 按钮，点开看该数值的说明。
 */
export function InfoRow({
  label,
  value,
  highlight,
  accent,
  labelWidth = 88,
  hintKey,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  accent?: string;
  labelWidth?: number;
  hintKey?: HintKey;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 24 }}>
      <AppText style={{ width: labelWidth, fontSize: fontSize.sm, color: colors.textSecondary }}>{label}</AppText>
      {hintKey ? <InfoHint hintKey={hintKey} size={13} /> : null}
      <AppText
        numberOfLines={1}
        ellipsizeMode="tail"
        style={[
          {
            flex: 1,
            textAlign: 'right',
            fontSize: fontSize.md,
            color: accent ?? colors.text,
            fontFamily: fontMono,
          },
          highlight && { fontWeight: '700' },
        ]}
      >
        {value}
      </AppText>
    </View>
  );
}
