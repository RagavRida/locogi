import { useColorScheme } from 'react-native';

// ─── COLOR TOKENS ─────────────────────────────────────────────────────────────

const lightColors = {
  // Base
  bg: '#F2F2F7', // Apple standard grouped background
  bgElevated: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceHover: '#F4F4F5',

  // Accent — refined, premium
  accent: '#007AFF', // Classic iOS blue
  accentDim: '#5AC8FA',
  accentSoft: 'rgba(0, 122, 255, 0.1)',

  // Text
  text: '#1C1C1E',
  textSecondary: '#8E8E93',
  textTertiary: '#AEAEB2',

  // Semantic
  success: '#34C759',
  warning: '#FF9500',
  danger: '#FF3B30',
  info: '#007AFF',

  // Borders
  border: 'rgba(60, 60, 67, 0.15)', // Very subtle borders
  borderLight: 'rgba(60, 60, 67, 0.08)',
};

const darkColors = {
  // Base
  bg: '#000000', // Deep charcoal / True black
  bgElevated: '#1C1C1E',
  surface: '#1C1C1E', // standard Apple dark surface
  surfaceHover: '#2C2C2E',

  // Accent
  accent: '#0A84FF',
  accentDim: '#64D2FF',
  accentSoft: 'rgba(10, 132, 255, 0.15)',

  // Text
  text: '#FFFFFF',
  textSecondary: '#EBEBF5', // with opacity in use
  textTertiary: 'rgba(235, 235, 245, 0.6)',

  // Semantic
  success: '#30D158',
  warning: '#FF9F0A',
  danger: '#FF453A',
  info: '#0A84FF',

  // Borders
  border: 'rgba(84, 84, 88, 0.35)', // Adjusted for dark mode
  borderLight: 'rgba(84, 84, 88, 0.2)',
};

export const useThemeColors = () => {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkColors : lightColors;
};

// Fallback for non-hook usage (defaults to light for static references if necessary)
export const colors = lightColors; 

// ─── GLASS TOKENS ─────────────────────────────────────────────────────────────

export const glassTokens = {
  light: {
    background: 'rgba(255, 255, 255, 0.70)',
    border: 'rgba(255, 255, 255, 0.50)',
    blurRadius: 25,
    elevation1: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.04,
      shadowRadius: 8,
      elevation: 2,
    },
    elevation2: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.06,
      shadowRadius: 16,
      elevation: 5,
    },
  },
  dark: {
    background: 'rgba(30, 30, 35, 0.65)',
    border: 'rgba(255, 255, 255, 0.12)',
    blurRadius: 25,
    elevation1: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 2,
    },
    elevation2: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.3,
      shadowRadius: 16,
      elevation: 5,
    },
  }
};

export const useGlassTokens = () => {
  const scheme = useColorScheme();
  return scheme === 'dark' ? glassTokens.dark : glassTokens.light;
};


// ─── LAYOUT & TYPOGRAPHY TOKENS ──────────────────────────────────────────────

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 18, // Adjusted for premium card feel
  xl: 24, // Adjusted for larger glass cards
  full: 999,
};

// Updated typography to be premium, highly readable, clear hierarchy
export const typography = {
  h1: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5, lineHeight: 34 }, 
  h2: { fontSize: 22, fontWeight: '600' as const, letterSpacing: -0.3, lineHeight: 28 },
  h3: { fontSize: 18, fontWeight: '600' as const, letterSpacing: -0.2, lineHeight: 24 },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22 },
  bodyBold: { fontSize: 16, fontWeight: '600' as const, lineHeight: 22 },
  caption: { fontSize: 14, fontWeight: '400' as const, lineHeight: 18 },
  tiny: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
};
