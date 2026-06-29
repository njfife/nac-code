import { useEffect } from 'react'
import './styles/tokens.css'
import './styles/global.css'
import Shell from './components/Shell'
import { initPersistence } from './store/persist'
import { initRuntime } from './store/runtime'

export default function App() {
  useEffect(() => {
    void initPersistence()
    initRuntime()
  }, [])
  return <Shell />
}
