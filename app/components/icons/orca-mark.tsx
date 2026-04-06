import orcaMarkUrl from "../../assets/orca-mark.svg";

type OrcaMarkProps = {
  className?: string;
  alt?: string;
};

export function OrcaMark({ className = "h-5 w-5", alt = "Orca mark" }: OrcaMarkProps) {
  return <img src={orcaMarkUrl} alt={alt} className={className} />;
}
