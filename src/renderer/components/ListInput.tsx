import { Button, Input, InputOnChangeData } from '@fluentui/react-components';
import { AddCircleRegular, SubtractCircleRegular } from '@fluentui/react-icons';
import { ChangeEvent, useCallback, useEffect, useState } from 'react';

export default function ListInput({
  placeholder,
  onChange,
}: {
  label: string;
  placeholder: string;
  onChange: (value: string[]) => void;
}) {
  const [inputValue, setInputValue] = useState<string>('');
  const [value, setValue] = useState<string[]>([]);

  const add = useCallback(() => {
    if (inputValue.trim() !== '') {
      setValue((state) => [...state, inputValue]);
      setInputValue('');
    }
  }, [inputValue]);

  const del = (idx: number) => {
    setValue((state) => state.filter((_, i) => i !== idx));
  };

  useEffect(() => {
    let val = [];
    if (inputValue.trim()) {
      val.push(inputValue.trim());
    }
    if (value.length) {
      val = val.concat(value);
    }
    onChange(val);
  }, [inputValue, value]);

  useEffect(() => {
    return () => {
      setInputValue('');
      setValue([]);
    };
  }, []);

  return (
    <div>
      <div className="flex justify-start items-center gap-1">
        <Input
          placeholder={placeholder}
          className="flex-grow"
          value={inputValue}
          onKeyDown={(evt) => {
            if (evt.key === 'Enter') {
              add();
            }
          }}
          onChange={(_: ChangeEvent, data: InputOnChangeData) => {
            setInputValue(data.value);
          }}
        />
        <Button icon={<AddCircleRegular />} appearance="subtle" onClick={add} />
      </div>
      <div className="flex flex-col pr-9 mt-0.5">
        {value.map((val: string, idx: number) => {
          return (
            <div
              key={idx}
              className="p-1 flex justify-start items-center bg-brand-surface-2 my-1 rounded"
            >
              <span className="flex-grow">{val}</span>
              <Button
                icon={<SubtractCircleRegular />}
                appearance="subtle"
                size="small"
                onClick={() => {
                  del(idx);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
