import { ChangeEventHandler, FC, useState } from "react";

export const OPENAI_TOKEN_KEY = "openai-token";

interface SettingsProps {
  close: () => void;
}
export const Settings: FC<SettingsProps> = ({ close }) => {
  const [dirty, setDirty] = useState(false);
  const [openaiToken, setOpenaiToken] = useState(
    localStorage.getItem(OPENAI_TOKEN_KEY) ?? ""
  );

  const onChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    setOpenaiToken(e.target.value);
    setDirty(true);
  };
  const onSubmit = () => {
    setDirty(false);
    localStorage.setItem(OPENAI_TOKEN_KEY, openaiToken);
  };
  return (
    <div
      className="fixed inset-0 flex justify-center items-center bg-[rgba(0,0,0,0.6)] z-[10000000] cursor-pointer"
      onClick={(e) => {
        if (e.target !== e.currentTarget) {
          return;
        }
        close();
      }}
    >
      <div className="w-[600px] h-[600px] bg-white rounded canvas-item p-6 cursor-auto">
        <div className="flex justify-between mb-4">
          <div className="font-bold text-3xl mb-4">Settings</div>
          <span
            className="material-symbols-outlined text-[24px] cursor-pointer hover:opacity-60"
            onClick={close}
          >
            close
          </span>
        </div>
        <div className="text-xl">
          OpenAI API Key{" "}
          <span className="text-sm">
            (if you are on the hosted version, no need to set)
          </span>
        </div>
        <div className="flex h-10">
          <input
            type="password"
            value={openaiToken}
            onChange={onChange}
            className="flex-1 border border-gray-700 rounded mr-4 pl-2"
          />
          <button
            disabled={!dirty}
            className="flex justify-center items-center w-16 bg-black hover:opacity-90 border rounded disabled:opacity-60"
            onClick={onSubmit}
          >
            <span className="material-symbols-outlined text-[14px] text-white">
              check
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
