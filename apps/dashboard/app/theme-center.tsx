import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, Image, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { AppText } from '../src/components/AppText';
import { Card } from '../src/components/Card';
import { useAppTheme } from '../src/ThemeProvider';
import { themePacks, type ResolvedThemeMode, type ThemeMode, type ThemePack, type ThemePackId } from '../src/themePacks';
import { fontSize, radius, spacing } from '../src/theme';
import { useVehicleData } from '../src/vehicleData';

const modes: { id: ThemeMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'system', label: '跟随系统', icon: 'phone-portrait-outline' },
  { id: 'light', label: '浅色', icon: 'sunny-outline' },
  { id: 'dark', label: '深色', icon: 'moon-outline' },
];

export default function ThemeCenterScreen() {
  const router = useRouter();
  const { colors, mode, setMode, themePack, setThemePack, resolvedMode, dialogueEnabled, setDialogueEnabled } = useAppTheme();
  const [detail, setDetail] = useState<ThemePackId | null>(null);
  const selected = detail ? themePacks[detail] : null;
  const { vehicles } = useVehicleData();
  const vehiclePreviewUri = vehicles[0]?.custom_image_url ?? vehicles[0]?.image_url ?? null;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail) { setDetail(null); return true; }
      return false;
    });
    return () => sub.remove();
  }, [detail]);
  return (
    <View style={[s.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={s.content}>
        <View style={s.header}>
          <Pressable accessibilityLabel="返回" hitSlop={10} onPress={() => detail ? setDetail(null) : router.back()} style={[s.back, { backgroundColor: colors.surfaceSecondary }]}>
            <Ionicons name="arrow-back" size={20} color={colors.textPrimary} />
          </Pressable>
          <View><AppText style={s.title}>{selected ? '主题详情' : '主题中心'}</AppText><AppText style={[s.subtitle, { color: colors.textMuted }]}>{selected ? selected.name : `当前 · ${resolvedMode === 'dark' ? '深色' : '浅色'}`}</AppText></View>
        </View>

        {selected ? <ThemeDetail id={selected.id} vehiclePreviewUri={vehiclePreviewUri} onApply={async () => { if (selected.available) await setThemePack(selected.id); }} /> : <>
          <AppText style={[s.section, { color: colors.textSecondary }]}>显示模式</AppText>
          <Card pad={false} style={s.modeGroup}>
            {modes.map((item, index) => <Pressable key={item.id} onPress={() => void setMode(item.id)} style={[s.modeRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.borderSubtle }]}>
              <View style={[s.modeIcon, { backgroundColor: mode === item.id ? colors.primarySoft : colors.surfaceSecondary }]}><Ionicons name={item.icon} size={18} color={mode === item.id ? colors.primary : colors.textSecondary} /></View>
              <AppText style={s.modeLabel}>{item.label}</AppText>
              {mode === item.id && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
            </Pressable>)}
          </Card>
          <Card pad={false} style={s.dialogueGroup}><View style={s.dialogueRow}><View style={[s.modeIcon, { backgroundColor: colors.primarySoft }]}><Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.primary} /></View><View style={{ flex: 1 }}><AppText style={s.modeLabel}>角色台词</AppText><AppText style={[s.dialogueHint, { color: colors.textMuted }]}>仅显示主题氛围文字，不替代业务告警</AppText></View><Switch value={dialogueEnabled} onValueChange={v => void setDialogueEnabled(v)} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={dialogueEnabled ? colors.primary : colors.textDim} /></View></Card>
          <AppText style={[s.section, { color: colors.textSecondary }]}>主题包</AppText>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.packRow}>
            {(Object.keys(themePacks) as ThemePackId[]).map(id => {
              const pack = themePacks[id]; const active = id === themePack;
              return <Pressable key={id} onPress={() => setDetail(id)} style={[s.packCard, { backgroundColor: colors.surface, borderColor: active ? colors.primary : colors.borderSubtle }]}>
                <ThemeMockPreview pack={pack} mode={resolvedMode} vehiclePreviewUri={vehiclePreviewUri} compact />
                <View style={s.packMeta}><AppText style={s.packName}>{pack.name}</AppText>{active && <AppText style={[s.applied, { color: colors.primary }]}>使用中</AppText>}</View>
                <AppText style={[s.packDesc, { color: colors.textMuted }]} numberOfLines={2}>{pack.description}</AppText>
              </Pressable>;
            })}
          </ScrollView>
        </>}
      </ScrollView>
    </View>
  );
}

function ThemeDetail({ id, vehiclePreviewUri, onApply }: { id: ThemePackId; vehiclePreviewUri: string | null; onApply: () => void }) {
  const { colors, themePack, resolvedMode } = useAppTheme(); const pack = themePacks[id];
  return <>
    <ThemeMockPreview pack={pack} mode={resolvedMode} vehiclePreviewUri={vehiclePreviewUri} />
    <Card style={s.detailCard}><AppText style={s.detailName}>{pack.name}</AppText><AppText style={[s.detailDesc, { color: colors.textSecondary }]}>{pack.description}</AppText><View style={[s.detailLine, { borderTopColor: colors.borderSubtle }]}><AppText style={{ color: colors.textMuted }}>作者</AppText><AppText>{pack.author}</AppText></View><View style={[s.detailLine, { borderTopColor: colors.borderSubtle }]}><AppText style={{ color: colors.textMuted }}>版本</AppText><AppText>{pack.version}</AppText></View></Card>
    <Pressable disabled={!pack.available || themePack === id} onPress={onApply} style={[s.apply, { backgroundColor: pack.available && themePack !== id ? colors.primary : colors.surfaceSecondary }]}><AppText style={[s.applyText, { color: pack.available && themePack !== id ? colors.onPrimary : colors.textMuted }]}>{themePack === id ? '正在使用' : pack.available ? '应用主题' : '暂未开放'}</AppText></Pressable>
  </>;
}

function ThemeMockPreview({ pack, mode, vehiclePreviewUri, compact = false }: { pack: ThemePack; mode: ResolvedThemeMode; vehiclePreviewUri: string | null; compact?: boolean }) {
  const pc = pack.colors[mode];
  const previewCharacter = pack.preview ?? pack.assets?.characterHero;
  return <View style={[compact ? s.preview : s.detailPreview, { backgroundColor: pc.background, borderColor: pc.border }]}>
    <View style={[s.previewGlow, { backgroundColor: pc.primary }]} />
    {pack.available ? <><View style={s.mockHeader}><View><AppText style={[s.mockKicker, { color: pc.textMuted }]}>NINEBOT</AppText><AppText style={[s.mockTitle, { color: pc.textPrimary }]}>我的车辆</AppText></View><View style={[s.mockOnline, { backgroundColor: pc.surfaceSecondary }]}><View style={[s.mockDot, { backgroundColor: pc.success }]} /><AppText style={[s.mockOnlineText, { color: pc.textSecondary }]}>在线</AppText></View></View><View style={[s.previewHero, { backgroundColor: pc.surface, borderColor: pc.borderSubtle }]}><View style={s.mockEnergy}><AppText style={[s.mockNumber, { color: pc.textPrimary }]}>82%</AppText><AppText style={[s.mockRange, { color: pc.primary }]}>46.8 km</AppText></View><View style={[s.previewBarTrack, { backgroundColor: pc.primarySoft }]}><View style={[s.previewBar, { backgroundColor: pc.primary }]} /></View><View style={[s.mockVehicle, { backgroundColor: pc.primarySoft }]}>{vehiclePreviewUri ? <Image source={{ uri: vehiclePreviewUri }} resizeMode="contain" style={s.mockScooterImage} /> : <Ionicons name="bicycle-outline" size={compact ? 18 : 28} color={pc.primary} />}</View>{previewCharacter ? <Image source={previewCharacter} resizeMode="cover" style={[s.mockCharacter, compact && s.mockCharacterCompact]} /> : null}</View></> : <View style={s.unavailablePreview}><Ionicons name="image-outline" size={compact ? 24 : 42} color={pc.textDim} /><AppText style={[s.detailPreviewText, { color: pc.textSecondary }]}>素材未安装 / 即将推出</AppText><AppText style={[s.mockSlotText, { color: pc.textMuted }]}>角色、装饰与 Widget 槽位已就绪</AppText></View>}
  </View>;
}

const s = StyleSheet.create({
  screen: { flex: 1 }, content: { padding: spacing.lg, paddingTop: 48, paddingBottom: 40 }, header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xxl }, back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }, title: { fontSize: fontSize.xxl, fontWeight: '800' }, subtitle: { fontSize: fontSize.xs, marginTop: 2 }, section: { fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.sm, marginLeft: 4 }, modeGroup: { overflow: 'hidden' }, modeRow: { minHeight: 58, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, dialogueGroup: { marginTop: spacing.sm }, dialogueRow: { minHeight: 66, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md }, dialogueHint: { fontSize: fontSize.xs, marginTop: 2 }, modeIcon: { width: 34, height: 34, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, modeLabel: { flex: 1, fontSize: fontSize.md, fontWeight: '600' }, packRow: { gap: spacing.md, paddingRight: spacing.lg }, packCard: { width: 240, padding: spacing.sm, borderWidth: 1, borderRadius: radius.xl },
  preview: { height: 126, borderRadius: radius.lg, overflow: 'hidden', padding: 12, borderWidth: 1 }, previewGlow: { position: 'absolute', width: 130, height: 130, borderRadius: 65, opacity: 0.16, right: -35, top: -55 }, previewHero: { flex: 1, borderRadius: radius.md, padding: 10, borderWidth: 1, overflow: 'hidden' }, previewBarTrack: { height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 5, marginRight: '38%' }, previewBar: { width: '82%', height: '100%', borderRadius: 4 }, future: { position: 'absolute', top: 10, right: 10, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8 }, futureText: { fontSize: 10 }, packMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 10 }, packName: { flex: 1, fontSize: fontSize.md, fontWeight: '700' }, applied: { fontSize: fontSize.xs, fontWeight: '700' }, packDesc: { fontSize: fontSize.xs, lineHeight: 17, marginTop: 4 }, detailPreview: { height: 220, borderRadius: radius.xxl, padding: spacing.lg, overflow: 'hidden', borderWidth: 1 }, detailPreviewText: { fontSize: fontSize.sm },
  mockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }, mockKicker: { fontSize: 8, fontWeight: '800', letterSpacing: 1 }, mockTitle: { fontSize: fontSize.sm, fontWeight: '800' }, mockOnline: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10 }, mockDot: { width: 5, height: 5, borderRadius: 3 }, mockOnlineText: { fontSize: 8 }, mockEnergy: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }, mockNumber: { fontSize: fontSize.lg, fontWeight: '800' }, mockRange: { fontSize: fontSize.xs, fontWeight: '800' }, mockVehicle: { position: 'absolute', right: 8, bottom: 7, width: '32%', height: '54%', borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }, mockScooterImage: { width: '100%', height: '100%' }, mockCharacter: { position: 'absolute', right: 2, top: 2, width: 54, height: 72, borderRadius: 12, opacity: 0.72 }, mockCharacterCompact: { width: 36, height: 48, opacity: 0.68 }, unavailablePreview: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }, mockSlotText: { fontSize: fontSize.xs },
  detailCard: { marginTop: spacing.lg }, detailName: { fontSize: fontSize.xl, fontWeight: '800' }, detailDesc: { marginTop: spacing.sm, lineHeight: 21 }, detailLine: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.md, flexDirection: 'row', justifyContent: 'space-between' }, apply: { marginTop: spacing.lg, height: 50, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' }, applyText: { fontWeight: '800' },
});
