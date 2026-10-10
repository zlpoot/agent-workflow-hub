import { Enrollment } from './enrollment.js';

type Destination = 'Projects' | 'Executors' | 'Runs' | 'Timeline';
type WizardProps = {onNavigate:(view:Destination,project:string)=>void};

export function Wizard({onNavigate}:WizardProps) {
  return <section className="wizard" aria-label="项目接入"><Enrollment onConnected={project => onNavigate('Executors',project)} /></section>;
}
