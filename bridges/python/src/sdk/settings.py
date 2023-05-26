import json
import os
from os import path
from typing import Union, Any

from ..constants import SKILL_PATH


class Settings:
    def __init__(self):
        self.settings_path = path.join(SKILL_PATH, 'src', 'settings.json')
        self.settings_sample_path = path.join(SKILL_PATH, 'src', 'settings.sample.json')

    def is_already_set(self) -> bool:
        settings_sample = self.get_settings_sample()
        settings = self.get()
        return json.dumps(settings) != json.dumps(settings_sample)

    def clear(self) -> None:
        settings_sample = self.get_settings_sample()
        self.set(settings_sample)

    def get_settings_sample(self) -> dict[str, Any]:
        try:
            with open(self.settings_sample_path, 'r') as file:
                return json.load(file)
        except Exception as e:
            print(f"Error while reading settings sample at '{self.settings_sample_path}': {e}")
            raise e

    def get(self, key: Union[str, None] = None) -> dict[str, Any]:
        try:
            if not os.path.exists(self.settings_path):
                self.clear()

            with open(self.settings_path, 'r') as file:
                settings = json.load(file)

                if key is not None:
                    return settings[key]
                return settings
        except Exception as e:
            print(f"Error while reading settings at '{self.settings_path}': {e}")
            raise e

    def set(self, key_or_settings: Union[str, dict[str, Any]], value=None) -> dict[str, Any]:
        try:
            settings = self.get()

            if isinstance(key_or_settings, dict):
                new_settings = key_or_settings
            else:
                new_settings = {**settings, key_or_settings: value}

            with open(self.settings_path, 'w') as file:
                json.dump(new_settings, file, indent=2)

            return new_settings
        except Exception as e:
            print(f"Error while writing settings at '{self.settings_path}': {e}")
            raise e
