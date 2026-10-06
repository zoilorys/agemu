import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

// Every JavaScript load (launch or reload) gets a new ID, so reloads are observable on screen.
const loadId = Math.random().toString(36).slice(2, 10);

function Button({ testID, title, onPress }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [count, setCount] = useState(0);
  const [probes, setProbes] = useState(0);

  const probe = () => {
    const sequence = probes + 1;
    setProbes(sequence);
    console.log(`agemu-rn-probe log ${saved || 'unsaved'} ${sequence}`);
    console.info(`agemu-rn-probe info ${saved || 'unsaved'} ${sequence}`);
  };

  return (
    <View style={styles.screen}>
      <Text testID="fixtureReady" style={styles.title}>React Native fixture</Text>
      <Text testID="loadId">{`load ${loadId}`}</Text>
      <TextInput
        testID="draftInput"
        onChangeText={setDraft}
        placeholder="Type a value"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Button testID="saveButton" title="Save" onPress={() => setSaved(draft.trim())} />
      <Text testID="savedValue">{saved ? `saved ${saved}` : 'nothing saved'}</Text>
      <Button testID="incrementButton" title="Increment" onPress={() => setCount(count + 1)} />
      <Text testID="counterValue">{`count ${count}`}</Text>
      <Button testID="consoleProbeButton" title="Log probe" onPress={probe} />
      <Text testID="probeCount">{`probes ${probes}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, paddingTop: 96, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 10, fontSize: 18 },
  button: { backgroundColor: '#1f6feb', borderRadius: 6, padding: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 18 },
});
