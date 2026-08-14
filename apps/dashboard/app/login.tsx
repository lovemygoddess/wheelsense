import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppText } from '../src/components/AppText';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useAuth } from '../src/auth';
import { ApiError, getStoredBaseUrl, setBaseUrl } from '../src/api';
import { colors, fontMono, fontSize, radius, shadow, spacing } from '../src/theme';
import { LinearGradient } from '../src/components/LinearGradient';
import { useAppTheme } from '../src/ThemeProvider';

export default function LoginScreen() {
  const { login, unreachable, retry } = useAuth();
  const router = useRouter();
  const { colors: c, isDark } = useAppTheme();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [serverSaved, setServerSaved] = useState(false);

  // 只预填用户显式保存过的地址；首次安装留空（默认值仅作 API 兜底，
  // 不应冒充"已保存地址"出现在输入框里）。
  useEffect(() => { getStoredBaseUrl().then(u => setServerUrl(u ?? '')); }, []);
  useEffect(() => { if (unreachable) setShowServer(true); }, [unreachable]);

  useFocusEffect(useCallback(() => { StatusBar.setStyle(isDark ? 'light' : 'dark'); }, [isDark]));

  const submit = async () => {
    setSubmitting(true); setError(null);
    try { await login(password); router.replace('/'); }
    catch (e) {
      if (!(e instanceof ApiError)) setShowServer(true);
      setError(e instanceof Error ? e.message : '登录失败');
    }
    finally { setSubmitting(false); }
  };

  const saveServer = async () => {
    try {
      // R7: setBaseUrl validates the URL and throws on garbage — show the
      // reason inline instead of failing the next login attempt opaquely.
      await setBaseUrl(serverUrl);
      setServerSaved(true);
      setError(null);
      retry();
      setTimeout(() => setServerSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '服务器地址无效');
    }
  };

  return (
    <KeyboardAvoidingView style={[s.container, { backgroundColor: c.background }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
      <View style={[s.ambient, { backgroundColor: c.primarySoft }]} />
      <View style={[s.ambientSecondary, { backgroundColor: c.infoSoft }]} />
      <View style={[s.card, { backgroundColor: c.surface, borderColor: c.borderSubtle }]}>
        <LinearGradient from={c.primarySoft} to={c.infoSoft} style={s.hero} steps={20}>
          <View style={s.brandRow}>
            <View style={[s.logoBox, { backgroundColor: c.surface }]}><Ionicons name="flash" size={22} color={c.primary} /></View>
            <AppText style={[s.brand, { color: c.primary }]}>NINEBOT · COMMAND</AppText>
          </View>
          <AppText style={[s.title, { color: c.textPrimary }]}>你的车辆，{`\n`}一眼掌握。</AppText>
          <AppText style={[s.subtitle, { color: c.textSecondary }]}>仪表、能量、电池与远程设备统一入口</AppText>
          <View style={[s.heroLine, { backgroundColor: c.primary }]} />
        </LinearGradient>
        <View style={s.form}>
        <View>
          <AppText style={[s.formTitle, { color: c.textPrimary }]}>安全登录</AppText>
          <AppText style={[s.formSubtitle, { color: c.textMuted }]}>输入仪表盘密码继续</AppText>
        </View>
        {unreachable && (
          <View style={[s.warnBox, { backgroundColor: c.dangerSoft }]}>
            <Ionicons name="cloud-offline-outline" size={16} color={c.danger} />
            <AppText style={[s.warnText, { color: c.danger }]}>无法连接服务器，请在下方检查服务器地址</AppText>
          </View>
        )}
        <TextInput
          style={[s.input, { backgroundColor: c.surfaceSecondary, borderColor: c.border, color: c.textPrimary }]}
          placeholderTextColor={c.textMuted}
          placeholder="密码"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
          autoFocus
        />
        {error && <AppText style={s.error}>{error}</AppText>}
        <Pressable
          style={[s.btn, { backgroundColor: c.primary }, (submitting || password === '') && s.btnDisabled]}
          onPress={submit}
          disabled={submitting || password === ''}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <AppText style={s.btnText}>解锁</AppText>
          )}
        </Pressable>

        <Pressable style={s.serverToggle} onPress={() => setShowServer(v => !v)}>
          <Ionicons name={showServer ? 'chevron-down' : 'chevron-forward'} size={14} color={c.textMuted} />
          <AppText style={[s.serverToggleText, { color: c.textMuted }]}>服务器地址</AppText>
          <AppText style={[s.serverCurrent, { color: c.textMuted }]} numberOfLines={1}>{serverUrl || ' '}</AppText>
        </Pressable>
        {showServer && (
          <View style={s.serverBox}>
            <TextInput
              style={[s.input, { backgroundColor: c.surfaceSecondary, borderColor: c.border, color: c.textPrimary }]}
              placeholderTextColor={c.textMuted}
              placeholder="https://example.com"
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Pressable style={[s.btn, { backgroundColor: c.primary }, s.serverSaveBtn, serverUrl.trim() === '' && s.btnDisabled]} onPress={saveServer} disabled={serverUrl.trim() === ''}>
              <AppText style={s.btnText}>{serverSaved ? '已保存' : '保存地址'}</AppText>
            </Pressable>
            <AppText style={[s.hint, { color: c.textMuted }]}>局域网可填 http://192.0.2.10:8000，公网请使用你自己的 HTTPS 域名。保存后点「解锁」即用新地址登录。</AppText>
          </View>
        )}

        <View style={s.securityRow}>
          <Ionicons name="shield-checkmark-outline" size={14} color={c.primary} />
          <AppText style={[s.securityText, { color: c.textMuted }]}>登录凭据仅保存在本机安全存储</AppText>
        </View>
        </View>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  ambient: { position: 'absolute', width: 280, height: 280, borderRadius: 180, top: '8%', right: -110, opacity: 0.62 },
  ambientSecondary: { position: 'absolute', width: 220, height: 220, borderRadius: 140, bottom: '5%', left: -100, opacity: 0.45 },
  card: { width: '100%', maxWidth: 390, backgroundColor: colors.card, borderRadius: radius.xxl, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderLight, ...shadow.raised },
  hero: { minHeight: 240, padding: spacing.xxl } as any,
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xxl },
  logoBox: { width: 38, height: 38, borderRadius: radius.md, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.card },
  brand: { color: colors.primary, fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 1.5 },
  title: { fontSize: 31, lineHeight: 38, fontWeight: '800', color: colors.text, letterSpacing: -0.7 },
  subtitle: { marginTop: spacing.md, fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },
  heroLine: { marginTop: spacing.xl, width: 46, height: 3, borderRadius: 3, backgroundColor: colors.primary },
  form: { padding: spacing.xxl, gap: spacing.lg },
  formTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  formSubtitle: { marginTop: 3, fontSize: fontSize.sm, color: colors.textMuted },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: 14, fontSize: fontSize.md, backgroundColor: colors.cardAlt, color: colors.text },
  btn: { backgroundColor: colors.primary, paddingVertical: 15, borderRadius: radius.lg, alignItems: 'center' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  error: { fontSize: fontSize.sm, color: colors.danger, textAlign: 'center' },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', lineHeight: 16, fontFamily: fontMono },
  serverToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
  serverToggleText: { fontSize: fontSize.sm, color: colors.textMuted },
  serverCurrent: { fontSize: fontSize.xs, color: colors.textMuted, flexShrink: 1 },
  serverBox: { gap: spacing.md, marginTop: -spacing.xs },
  serverSaveBtn: { paddingVertical: 11 },
  warnBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.dangerLight, borderRadius: radius.lg, paddingVertical: 9, paddingHorizontal: 12 },
  warnText: { fontSize: fontSize.sm, color: colors.danger, flexShrink: 1 },
  securityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  securityText: { fontSize: fontSize.xs, color: colors.textMuted },
});
