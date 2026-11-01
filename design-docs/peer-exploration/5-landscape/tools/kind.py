"""What a project is, as the survey's reader described it: the description up to its first
punctuation ("statusline inside a larger tool", "not a statusline", ...). Export stores it on every
project, and everything downstream (triage's skip, the explorer's characteristics) reads that
stored field. [LAW:one-source-of-truth]"""
import re


def kind_of(what):
    return re.split(r'[(:;,]', what or '')[0].strip()
