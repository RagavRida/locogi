import React, { useState } from 'react';
import { StyleSheet, TextInput, TextInputProps, ViewStyle, StyleProp } from 'react-native';
import { GlassView } from './GlassView';
import { useThemeColors, typography, radius } from '../../theme';

interface GlassInputProps extends TextInputProps {
  containerStyle?: StyleProp<ViewStyle>;
}

export const GlassInput: React.FC<GlassInputProps> = ({ containerStyle, style, ...props }) => {
  const colors = useThemeColors();
  const [isFocused, setIsFocused] = useState(false);

  return (
    <GlassView 
      style={[
        styles.container, 
        isFocused && { borderColor: colors.accent, borderWidth: 1 }, // Subtle focus ring
        containerStyle
      ]} 
      intensity={30}
    >
      <TextInput
        style={[
          styles.input,
          { color: colors.text },
          style,
        ]}
        placeholderTextColor={colors.textSecondary}
        onFocus={(e) => {
          setIsFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          props.onBlur?.(e);
        }}
        {...props}
      />
    </GlassView>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.xl,
    minHeight: 48,
  },
  input: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    ...typography.body,
  },
});
