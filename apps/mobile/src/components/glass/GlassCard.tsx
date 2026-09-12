import React from 'react';
import { StyleSheet, StyleProp, ViewStyle, View } from 'react-native';
import { GlassView } from './GlassView';
import { radius } from '../../theme';

interface GlassCardProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  elevation?: 'none' | 'elevation1' | 'elevation2';
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  style,
  elevation = 'elevation1',
}) => {
  return (
    // We wrap in a regular view for the shadow to apply correctly outside the overflow: hidden of GlassView
    <View style={[styles.shadowWrapper, style]}>
      <GlassView
        elevation={elevation}
        style={styles.card}
      >
        {children}
      </GlassView>
    </View>
  );
};

const styles = StyleSheet.create({
  shadowWrapper: {
    borderRadius: radius.xl,
  },
  card: {
    borderRadius: radius.xl,
    padding: 16, // Default padding, can be overridden by inner containers if needed
  },
});
