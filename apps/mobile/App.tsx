import 'react-native-gesture-handler'
import React from 'react'
import { StatusBar } from 'expo-status-bar'
import { NavigationContainer, DarkTheme } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { useStore } from './src/store'
import { colors } from './src/theme'
import LoginScreen from './src/screens/LoginScreen'
import RoleScreen from './src/screens/RoleScreen'
import ChatScreen from './src/screens/ChatScreen'
import HistoryScreen from './src/screens/HistoryScreen'
import SettingsScreen from './src/screens/SettingsScreen'
import VendorInboxScreen from './src/screens/VendorInboxScreen'

export type RootStackParamList = {
  Login: undefined
  Role: undefined
  Chat: undefined
  History: undefined
  Settings: undefined
  VendorInbox: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bgElevated,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
}

export default function App() {
  const { isAuthenticated, role } = useStore()

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <NavigationContainer theme={navTheme}>
            <Stack.Navigator
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
                animation: 'slide_from_right',
              }}
            >
              {!isAuthenticated ? (
                <Stack.Screen name="Login" component={LoginScreen} />
              ) : !role ? (
                <Stack.Screen name="Role" component={RoleScreen} />
              ) : (
                <>
                  <Stack.Screen name="Chat" component={ChatScreen} />
                  <Stack.Screen
                    name="History"
                    component={HistoryScreen}
                    options={{ animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen name="Settings" component={SettingsScreen} />
                  <Stack.Screen name="VendorInbox" component={VendorInboxScreen} />
                </>
              )}
            </Stack.Navigator>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
