import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle, useColorScheme } from 'react-native';
import { BlurView } from 'expo-blur';
import { useGlassTokens } from '../../theme';

interface GlassViewProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  elevation?: 'none' | 'elevation1' | 'elevation2';
}

export const GlassView: React.FC<GlassViewProps> = ({
  children,
  style,
  intensity = 25,
  elevation = 'none',
}) => {
  const scheme = useColorScheme();
  const glass = useGlassTokens();

  const isDark = scheme === 'dark';

  return (
    <View style={[
      styles.container,
      elevation !== 'none' && glass[elevation],
      style,
    ]}>
      <BlurView
        style={StyleSheet.absoluteFill}
        tint={isDark ? 'dark' : 'light'}
        intensity={intensity}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: glass.background,
            borderColor: glass.border,
            borderWidth: StyleSheet.hairlineWidth,
          }
        ]}
      />
      {/* Content Layer */}
      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  content: {
    flex: 1,
  },
});
