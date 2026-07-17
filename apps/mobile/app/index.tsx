import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>Guandan</Text>
        <Text style={styles.subtitle}>iPhone multiplayer card game</Text>
        <Text style={styles.status}>Mobile scaffold ready</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f7f4ed',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    color: '#18251d',
    fontSize: 36,
    fontWeight: '700',
  },
  subtitle: {
    color: '#405348',
    fontSize: 18,
    marginTop: 12,
    textAlign: 'center',
  },
  status: {
    color: '#287046',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 28,
  },
});
