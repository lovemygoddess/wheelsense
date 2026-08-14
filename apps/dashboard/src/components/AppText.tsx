import { Text, TextProps } from 'react-native';
import { useAppTheme } from '../ThemeProvider';

/**
 * App-wide Text wrapper.
 *
 * Caps font scaling at 1.3× so a large system font size can't blow up the
 * dashboard layout (tab labels, metric tiles, lists). 1.3× keeps good
 * accessibility headroom without breaking the design.
 */
export function AppText({ style, maxFontSizeMultiplier = 2, ...props }: TextProps) {
  const { colors } = useAppTheme();
  return <Text maxFontSizeMultiplier={maxFontSizeMultiplier} {...props} style={[{ color: colors.textPrimary }, style]} />;
}

export default AppText;
