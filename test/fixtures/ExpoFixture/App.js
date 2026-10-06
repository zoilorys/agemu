import { useEffect, useRef, useState } from 'react';
import { Button, LogBox, StyleSheet, Text, TextInput, View } from 'react-native';

// Console probes are captured by `agemu logs js`; toasts would cover fixture controls.
LogBox.ignoreAllLogs(true);

// A new value per JavaScript load makes a completed reload observable.
const session = Math.random().toString(36).slice(2, 10);
console.log(`agemu-expo-boot:${session}`);

const probeTicks = 10;
const probeIntervalMs = 300;

export default function App() {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [count, setCount] = useState(0);
  const [probe, setProbe] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  // Emits a bounded burst so a capture that connects after the tap still sees whole ticks.
  const runProbe = () => {
    if (timer.current) return;
    const token = saved || 'none';
    let tick = 0;
    setProbe('running');
    timer.current = setInterval(() => {
      tick += 1;
      console.log(`agemu-expo-probe:log:${token}:${tick}`);
      console.warn(`agemu-expo-probe:warn:${token}:${tick}`);
      console.error(`agemu-expo-probe:error:${token}:${tick}`);
      if (tick === probeTicks) {
        clearInterval(timer.current);
        timer.current = null;
        console.log(`agemu-expo-probe:done:${token}`);
        setProbe(`done:${probeTicks}`);
      }
    }, probeIntervalMs);
  };

  return (
    <View style={styles.screen}>
      <Text testID="fixtureTitle" style={styles.title}>agemu Expo fixture</Text>
      <Text testID="sessionValue">{`session:${session}`}</Text>
      {/* Uncontrolled: a lagging JS thread would otherwise write stale `value` state over native keystrokes. */}
      <TextInput
        testID="draftInput"
        style={styles.input}
        onChangeText={setDraft}
        placeholder="draft"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button testID="saveButton" title="Save" onPress={() => setSaved(draft)} />
      <Text testID="savedValue">{`saved:${saved || '(none)'}`}</Text>
      <Text testID="counterValue">{`count:${count}`}</Text>
      <Button testID="incrementButton" title="Increment" onPress={() => setCount(value => value + 1)} />
      <Button testID="probeButton" title="Log probe" onPress={runProbe} />
      <Text testID="probeStatus">{`probe:${probe}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '600', marginTop: 48 },
  input: { borderWidth: 1, borderColor: '#888', padding: 8, fontSize: 18 },
});
