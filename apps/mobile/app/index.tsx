import {
  type ScaffoldClientToServerEvents,
  type ScaffoldServerToClientEvents,
} from '@guandan/protocol';
import { randomUUID } from 'expo-crypto';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { io, type Socket } from 'socket.io-client';

import {
  acquireSmokeRun,
  CONNECTION_TIMEOUT_MS,
  createRunSmokeDependencies,
  getServerHost,
  releaseSmokeRun,
  runInfrastructureSmoke,
  SERVER_URL,
  type SmokePhase,
  type SmokeTerminalResult,
} from '../src/infrastructure-smoke';

const smokeDependencies = createRunSmokeDependencies(
  randomUUID,
  (url) =>
    io(url, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: CONNECTION_TIMEOUT_MS,
    }) as Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
);

const PHASE_LABELS: Record<SmokePhase, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  waiting: 'Waiting for database verification',
  success: 'Success',
  failure: 'Failure',
};

export default function HomeScreen() {
  const [phase, setPhase] = useState<SmokePhase>('idle');
  const [result, setResult] = useState<SmokeTerminalResult>();
  const runningRef = useRef(false);
  const isRunning = phase === 'connecting' || phase === 'waiting';

  const runSmokeTest = (): void => {
    if (!acquireSmokeRun(runningRef)) {
      return;
    }

    setResult(undefined);
    void runInfrastructureSmoke(SERVER_URL, setPhase, smokeDependencies).then(
      (nextResult) => {
        setResult(nextResult);
        setPhase(nextResult.phase);
        releaseSmokeRun(runningRef);
      },
      () => {
        setResult({
          phase: 'failure',
          category: 'invalid-acknowledgement',
          message: 'The smoke test could not be completed.',
        });
        setPhase('failure');
        releaseSmokeRun(runningRef);
      },
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Guandan</Text>
        <Text style={styles.subtitle}>Infrastructure verification</Text>

        <View style={styles.panel}>
          <Text style={styles.label}>Configured server host</Text>
          <Text selectable style={styles.value}>
            {getServerHost(SERVER_URL)}
          </Text>

          <Text style={styles.label}>State</Text>
          <View style={styles.phaseRow}>
            {isRunning ? <ActivityIndicator color="#287046" /> : null}
            <Text style={styles.phase}>{PHASE_LABELS[phase]}</Text>
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={isRunning}
            onPress={runSmokeTest}
            style={({ pressed }) => [
              styles.button,
              isRunning && styles.buttonDisabled,
              pressed && !isRunning && styles.buttonPressed,
            ]}
          >
            <Text style={styles.buttonText}>Run Database Smoke Test</Text>
          </Pressable>

          {result?.phase === 'success' ? (
            <View style={styles.result}>
              <Text style={styles.successTitle}>
                Database verification succeeded
              </Text>
              <ResultRow
                label="Command ID"
                value={result.acknowledgement.commandId}
              />
              <ResultRow
                label="Probe token"
                value={result.acknowledgement.probeToken}
              />
              <ResultRow
                label="Database updated"
                value={result.acknowledgement.databaseUpdatedAt}
              />
              <ResultRow
                label="Server completed"
                value={result.acknowledgement.completedAt}
              />
            </View>
          ) : null}

          {result?.phase === 'failure' ? (
            <View style={styles.result}>
              <Text style={styles.failureTitle}>{result.message}</Text>
              <ResultRow label="Failure type" value={result.category} />
              {result.code === undefined ? null : (
                <ResultRow label="Server error code" value={result.code} />
              )}
              <Text style={styles.retryText}>
                Correct the issue, then run the test again manually.
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.resultRow}>
      <Text style={styles.resultLabel}>{label}</Text>
      <Text selectable style={styles.resultValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f7f4ed',
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    color: '#18251d',
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: '#405348',
    fontSize: 18,
    marginTop: 8,
    textAlign: 'center',
  },
  panel: {
    backgroundColor: '#ffffff',
    borderColor: '#d8ded8',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 28,
    padding: 20,
  },
  label: {
    color: '#617067',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 14,
    textTransform: 'uppercase',
  },
  value: {
    color: '#18251d',
    fontSize: 16,
    marginTop: 5,
  },
  phaseRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  phase: {
    color: '#287046',
    fontSize: 17,
    fontWeight: '600',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#287046',
    borderRadius: 10,
    marginTop: 24,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonPressed: {
    backgroundColor: '#1f5938',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  result: {
    borderTopColor: '#d8ded8',
    borderTopWidth: 1,
    marginTop: 24,
    paddingTop: 20,
  },
  successTitle: {
    color: '#287046',
    fontSize: 18,
    fontWeight: '700',
  },
  failureTitle: {
    color: '#9c2f2f',
    fontSize: 17,
    fontWeight: '700',
  },
  resultRow: {
    marginTop: 12,
  },
  resultLabel: {
    color: '#617067',
    fontSize: 13,
    fontWeight: '600',
  },
  resultValue: {
    color: '#18251d',
    fontFamily: 'monospace',
    fontSize: 13,
    marginTop: 3,
  },
  retryText: {
    color: '#405348',
    fontSize: 14,
    marginTop: 16,
  },
});
