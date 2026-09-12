import React from 'react';
import { StyleSheet, Pressable, PressableProps, Text, ViewStyle, TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { GlassView } from './GlassView';
import { useThemeColors, radius, typography } from '../../theme';

interface GlassButtonProps extends PressableProps {
  title: string;
  variant?: 'primary' | 'secondary' | 'tertiary';
  style?: ViewStyle;
  textStyle?: TextStyle;
  destructive?: boolean;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const GlassButton: React.FC<GlassButtonProps> = ({
  title,
  variant = 'primary',
  style,
  textStyle,
  destructive = false,
  ...props
}) => {
  const colors = useThemeColors();
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const handlePressIn = () => {
    scale.value = withSpring(0.96, { damping: 15, stiffness: 300 });
    opacity.value = withTiming(0.8, { duration: 100 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 300 });
    opacity.value = withTiming(1, { duration: 150 });
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const getBackgroundColor = () => {
    if (variant === 'primary') {
      return destructive ? colors.danger : colors.accent;
    }
    return 'transparent';
  };

  const getTextColor = () => {
    if (variant === 'primary') return '#FFFFFF'; // High contrast text on solid primary
    if (destructive) return colors.danger;
    return colors.text;
  };

  const content = (
    <Text style={[styles.text, { color: getTextColor() }, textStyle]}>
      {title}
    </Text>
  );

  return (
    <AnimatedPressable
      {...props}
      onPressIn={(e) => {
        handlePressIn();
        props.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        handlePressOut();
        props.onPressOut?.(e);
      }}
      style={[styles.base, animatedStyle, style]}
    >
      {variant === 'primary' ? (
        <Animated.View style={[styles.solidContainer, { backgroundColor: getBackgroundColor() }]}>
          {content}
        </Animated.View>
      ) : variant === 'secondary' ? (
        <GlassView style={styles.glassContainer} intensity={30}>
          {content}
        </GlassView>
      ) : (
        <Animated.View style={styles.textContainer}>
          {content}
        </Animated.View>
      )}
    </AnimatedPressable>
  );
};

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.lg,
  },
  solidContainer: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassContainer: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    ...typography.bodyBold,
  },
});
