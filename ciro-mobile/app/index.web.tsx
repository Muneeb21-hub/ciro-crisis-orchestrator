import React from 'react';
import { StyleSheet, View, Text } from 'react-native';

export default function MapDashboardWeb() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Mobile Command Center</Text>
      <Text style={styles.text}>
        The interactive map using `react-native-maps` is currently optimized for native mobile devices and is not supported out-of-the-box on the web platform.
      </Text>
      <Text style={styles.text}>
        Please run this application on an Android emulator (press 'a'), an iOS simulator (press 'i'), or your physical device using the Expo Go app.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f5f5f5'
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#333'
  },
  text: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 10,
    color: '#555',
    lineHeight: 24
  }
});
