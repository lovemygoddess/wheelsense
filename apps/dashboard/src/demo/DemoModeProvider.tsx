import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearDemoWidgetData, refreshNotificationsNow, saveDemoWidgetData } from '../widgetData';
import { getDemoWidgetPayload, resetDemoSimulation } from './demoData';
import { initializeDemoMode, isDemoModeSync, setDemoModeEnabled, subscribeDemoMode } from './demoStore';

type DemoModeContextValue = {
  isDemoMode: boolean;
  ready: boolean;
  setDemoMode: (enabled: boolean) => Promise<void>;
};

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [isDemoMode, setIsDemoMode] = useState(isDemoModeSync());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeDemoMode(setIsDemoMode);
    void initializeDemoMode().then((value) => {
      setIsDemoMode(value); setReady(true);
      if (value) void saveDemoWidgetData(getDemoWidgetPayload());
    });
    return unsubscribe;
  }, []);

  const setDemoMode = useCallback(async (value: boolean) => {
    resetDemoSimulation();
    await setDemoModeEnabled(value);
    if (value) {
      await saveDemoWidgetData(getDemoWidgetPayload());
    } else {
      await clearDemoWidgetData();
      // Ask the native provider to immediately rehydrate the widget from the
      // real account after the demo cache flag is cleared.
      void refreshNotificationsNow();
    }
  }, []);

  const context = useMemo(() => ({ isDemoMode, ready, setDemoMode }), [isDemoMode, ready, setDemoMode]);
  return <DemoModeContext.Provider value={context}>{children}</DemoModeContext.Provider>;
}

export function useDemoMode(): DemoModeContextValue {
  const value = useContext(DemoModeContext);
  if (!value) throw new Error('useDemoMode must be used inside DemoModeProvider');
  return value;
}
